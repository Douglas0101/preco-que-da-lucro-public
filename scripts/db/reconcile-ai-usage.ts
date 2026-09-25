// TRILHO B — job de reconciliação de uso desconhecido (`usage_unknown`).
//
// O que este comando faz: encontra eventos que `settle` encerrou **sem medição**
// (`status='settled'` + `outcome='usage_unknown'`) e que são mais antigos que o
// corte configurado, e marca cada um como `reconciliation_failed` de forma
// persistida e auditável — com métrica e evento estruturado.
//
// O que ele deliberadamente **não** faz:
//   * não chama o gateway: `src/lib/chat.functions.ts` usa `/v1/chat/completions`
//     sem retrieval por id e `ai_usage` não guarda payload, então re-consultar o
//     uso é **estruturalmente impossível** — inventar um número aqui seria o pior
//     desfecho possível;
//   * não libera a reserva retida: por decisão humana registrada, a liberação é um
//     comando separado e explícito (`scripts/db/release-unknown-reservations.ts`),
//     para que devolver orçamento nunca seja um efeito colateral de um cron;
//   * não apaga o fato de o uso ter sido desconhecido: `real_tokens` continua
//     `NULL` e `status` continua `settled`.
//
// Por que um script e não uma rota HTTP: a decisão humana foi "script npm +
// cron documentado". Não há superfície nova exposta na aplicação.
//
// Fail-closed: `requireAdminUrl` só verifica presença e este script roda por
// `npx tsx` (sem o pre-hook do `env-guard`), então qualquer URL não-loopback é
// recusada **antes** de abrir conexão. O job nunca deve apontar para produção.
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../../src/db/schema";
import { setDatabaseForTests, type Database } from "../../src/db/client.server";
import {
  flushTelemetry,
  reportReconciliationOldestAge,
  startTelemetry,
} from "../../src/instrumentation/telemetry";
import {
  DEFAULT_RECONCILE_BATCH_SIZE,
  DEFAULT_RECONCILE_MIN_AGE_MS,
  MAX_RECONCILE_BATCH_SIZE,
  createBudgetLedger,
  type BudgetLedgerConfig,
} from "../../src/lib/ai/budget-ledger.server";
import type { RequestIdentity } from "../../src/lib/request-context";
import { requireAdminUrl } from "./migrate";

const BASE_CONFIG: BudgetLedgerConfig = {
  dailyModelCallLimit: 100,
  dailyTokenLimit: 1_000_000,
  dailyChatLimit: 1_000,
  inFlightLimit: 4,
  conservativeTokenBudget: 100,
  reservationTtlMs: 60 * 60 * 1000,
};

interface CliOptions {
  tenantIds: string[];
  allTenants: boolean;
  minAgeMs: number;
  batchSize: number;
  dryRun: boolean;
}

interface TenantIdentity {
  tenantId: string;
  userId: string;
  role: string;
}

interface TenantTotals {
  scannedCount: number;
  failedCount: number;
  oldestAgeMs: number | null;
}

function assertLoopback(label: string, value: string | undefined): void {
  if (value === undefined) return;
  let hostname: string;
  try {
    hostname = new URL(value).hostname;
  } catch {
    throw new Error(`${label} não é uma URL válida — recusando por segurança`);
  }
  if (hostname !== "127.0.0.1" && hostname !== "localhost" && hostname !== "::1") {
    throw new Error(
      `${label} aponta para "${hostname}", não para loopback — o job de reconciliação nunca roda contra host remoto`,
    );
  }
}

function parseOptions(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    tenantIds: [],
    allTenants: false,
    minAgeMs: DEFAULT_RECONCILE_MIN_AGE_MS,
    batchSize: DEFAULT_RECONCILE_BATCH_SIZE,
    dryRun: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--tenant") {
      if (!value) throw new Error("--tenant exige um uuid");
      options.tenantIds.push(value);
      index += 1;
    } else if (flag === "--all-tenants") {
      options.allTenants = true;
    } else if (flag === "--min-age-ms") {
      options.minAgeMs = Number(value);
      index += 1;
    } else if (flag === "--batch-size") {
      options.batchSize = Number(value);
      index += 1;
    } else if (flag === "--dry-run") {
      options.dryRun = true;
    } else {
      throw new Error(`argumento desconhecido: ${flag}`);
    }
  }
  if (options.tenantIds.length === 0 && !options.allTenants) {
    throw new Error(
      "informe --tenant <uuid> (repetível) ou --all-tenants; o job nunca varre tenants por conta própria sem ordem explícita",
    );
  }
  if (!Number.isInteger(options.minAgeMs) || options.minAgeMs < 0) {
    throw new Error("--min-age-ms exige inteiro >= 0");
  }
  if (
    !Number.isInteger(options.batchSize) ||
    options.batchSize < 1 ||
    options.batchSize > MAX_RECONCILE_BATCH_SIZE
  ) {
    throw new Error(`--batch-size exige inteiro entre 1 e ${MAX_RECONCILE_BATCH_SIZE}`);
  }
  return options;
}

function makeIdentity(tenant: TenantIdentity): RequestIdentity {
  return {
    userId: tenant.userId,
    tenantId: tenant.tenantId,
    roles: [tenant.role],
    correlationId: `reconcile-ai-usage:${tenant.tenantId}`,
    signal: new AbortController().signal,
  };
}

/**
 * Descobre as identidades que podem representar cada tenant. A enumeração lê
 * `tenants` e `tenant_memberships` (quem é dono/admin de quem) — nunca `ai_usage`.
 *
 * O isolamento **não** vem do RLS aqui: este CLI conecta por `DATABASE_ADMIN_URL`,
 * que é superusuário e portanto ignora RLS. Quem contém o acesso é o predicado
 * `tenant_id` explícito em cada query mais o `assertIdentityTenant` da biblioteca.
 * (O comentário anterior afirmava que o RLS seguia sendo a fronteira — era falso,
 * defeito D5 do adversarial.)
 */
interface TenantEnumeration {
  identities: readonly TenantIdentity[];
  /** Tenants sem nenhum membro owner/admin: existem, mas não têm identidade sob a
   * qual agir. Antes eram pulados em silêncio, então `--all-tenants` podia deixar
   * linha sem tratamento sem diagnóstico (defeito D4). */
  skippedTenantIds: readonly string[];
}

async function listTenantIdentities(pool: Pool): Promise<TenantEnumeration> {
  const result = await pool.query<{
    tenantId: string;
    userId: string | null;
    role: string | null;
  }>(
    `select t.id::text as "tenantId", tm.user_id as "userId", tm.role
     from tenants t
     left join tenant_memberships tm
       on tm.tenant_id = t.id and tm.role in ('owner', 'admin')
     order by t.id, case tm.role when 'owner' then 0 else 1 end, tm.user_id`,
  );
  const seen = new Map<string, TenantIdentity>();
  const skipped = new Set<string>();
  for (const row of result.rows) {
    if (row.userId === null || row.role === null) {
      skipped.add(row.tenantId);
      continue;
    }
    if (!seen.has(row.tenantId)) {
      seen.set(row.tenantId, { tenantId: row.tenantId, userId: row.userId, role: row.role });
    }
  }
  return { identities: [...seen.values()], skippedTenantIds: [...skipped] };
}

async function resolveTenantIdentity(pool: Pool, tenantId: string): Promise<TenantIdentity> {
  const result = await pool.query<{ userId: string; role: string }>(
    `select tm.user_id as "userId", tm.role
     from tenant_memberships tm
     where tm.tenant_id = $1 and tm.role in ('owner', 'admin')
     order by case tm.role when 'owner' then 0 else 1 end, tm.user_id
     limit 1`,
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) {
    throw new Error(`tenant ${tenantId} não tem membro owner/admin — sem identidade para agir`);
  }
  return { tenantId, userId: row.userId, role: row.role };
}

/** Prévia read-only: o que o job marcaria, sem marcar nada. */
async function previewCandidates(
  pool: Pool,
  tenantId: string,
  minAgeMs: number,
  batchSize: number,
): Promise<TenantTotals> {
  const cutoff = new Date(Date.now() - minAgeMs);
  const result = await pool.query<{ count: string; oldest: Date | null }>(
    `select count(*)::text as "count", min(settled_at) as "oldest"
     from (
       select settled_at from ai_usage
       where tenant_id = $1
         and status = 'settled'
         and outcome = 'usage_unknown'
         and settled_at is not null
         and settled_at < $2
       order by settled_at asc
       limit $3
     ) as candidates`,
    [tenantId, cutoff, batchSize],
  );
  const row = result.rows[0];
  const count = Number(row?.count ?? "0");
  return {
    scannedCount: count,
    failedCount: 0,
    oldestAgeMs: row?.oldest ? Date.now() - new Date(row.oldest).getTime() : null,
  };
}

async function main(): Promise<void> {
  const adminUrl = requireAdminUrl();
  assertLoopback("DATABASE_ADMIN_URL", adminUrl);
  assertLoopback("DATABASE_URL", process.env.DATABASE_URL);
  assertLoopback("DATABASE_URL_UNPOOLED", process.env.DATABASE_URL_UNPOOLED);

  const options = parseOptions(process.argv.slice(2));
  const pool = new Pool({ connectionString: adminUrl, max: 4 });
  const database = drizzle({ client: pool, schema });
  setDatabaseForTests(database as unknown as Database);
  let exitCode = 0;
  try {
    // As duas chamadas abaixo garantem provider registrado e dreno antes de sair.
    // LIMITE MEDIDO — NÃO leia isto como "as métricas deste processo saem":
    // os instrumentos de `applicationMetrics` nascem no IMPORT do módulo, quando
    // a API ainda devolve singletons noop (`NOOP_METER` compartilhado, `add()`
    // vazio), e `@opentelemetry/api` não tem proxy de métrica — registrar o
    // provider depois não re-vincula instrumento já criado. Enquanto o defeito
    // D7 (WP `F-otel-provider-order`) não for corrigido, `app.ai.reconciliation_*`
    // é inerte aqui; o alarme que funciona é o evento estruturado
    // `ai.reconciliation_failed`, uma linha por evento tratado.
    await startTelemetry();
    const enumeration = options.allTenants
      ? await listTenantIdentities(pool)
      : {
          identities: await Promise.all(
            options.tenantIds.map((id) => resolveTenantIdentity(pool, id)),
          ),
          skippedTenantIds: [] as string[],
        };
    const tenants = enumeration.identities;

    if (enumeration.skippedTenantIds.length > 0) {
      console.warn(
        `AVISO: ${enumeration.skippedTenantIds.length} tenant(s) sem membro owner/admin — ` +
          `nenhuma identidade para agir, nenhuma linha avaliada: ${enumeration.skippedTenantIds.join(",")}`,
      );
    }

    let scannedCount = 0;
    let failedCount = 0;
    let oldestAgeMs: number | null = null;
    // Um tenant sem owner/admin é backlog que NÃO conseguimos ler: publicar `0`
    // ou um máximo parcial subestimaria em silêncio. Sem cobertura completa o
    // gauge fica intocado e quem alarma é o AVISO acima mais os counters.
    const coverageComplete = enumeration.skippedTenantIds.length === 0;

    if (tenants.length === 0) {
      console.log(
        "TRILHO-B reconciliação: nenhum tenant com identidade owner/admin — nada a fazer",
      );
    }

    for (const tenant of tenants) {
      if (options.dryRun) {
        const preview = await previewCandidates(
          pool,
          tenant.tenantId,
          options.minAgeMs,
          options.batchSize,
        );
        scannedCount += preview.scannedCount;
        if (preview.oldestAgeMs !== null) {
          oldestAgeMs = Math.max(oldestAgeMs ?? 0, preview.oldestAgeMs);
        }
        console.log(
          `  tenant=${tenant.tenantId} dry-run: candidatos=${preview.scannedCount} mais_antigo_ms=${
            preview.oldestAgeMs ?? "n/a"
          }`,
        );
        continue;
      }

      const ledger = createBudgetLedger({ identity: makeIdentity(tenant), config: BASE_CONFIG });
      const result = await ledger.reconcileUnknownUsage(tenant.tenantId, {
        minAgeMs: options.minAgeMs,
        batchSize: options.batchSize,
      });
      scannedCount += result.scannedCount;
      failedCount += result.failedCount;
      if (result.oldestAgeMs !== null) {
        oldestAgeMs = Math.max(oldestAgeMs ?? 0, result.oldestAgeMs);
      }
      if (result.failedCount > 0) {
        console.log(
          `  tenant=${tenant.tenantId} marcados=${result.failedCount} mais_antigo_ms=${result.oldestAgeMs} ids=${result.usageIds.join(",")}`,
        );
      }
    }

    console.log(
      `TRILHO-B reconciliação: tenants=${tenants.length} candidatos=${scannedCount} marcados=${failedCount} mais_antigo_ms=${oldestAgeMs ?? "n/a"} modo=${
        options.dryRun ? "dry-run" : "aplicado"
      }`,
    );
    if (failedCount > 0) {
      // `reconciliation_failed` é o desfecho correto, não um erro do job — por
      // isso o exit code segue 0; sair != 0 aqui treinaria quem opera a ignorar o
      // cron. Quem alarma de verdade: o evento estruturado
      // `ai.reconciliation_failed`, emitido uma linha por evento tratado.
      // As métricas `app.ai.reconciliation_*` NÃO servem de alarme hoje — os
      // instrumentos nascem noop (defeito D7). Não monte alerta sobre elas.
      console.warn(
        `AVISO: ${failedCount} evento(s) sem medição possível. A reserva continua RETIDA. ` +
          `A liberação é decisão humana: scripts/db/release-unknown-reservations.ts --tenant <uuid> --usage-id <uuid> --confirm`,
      );
    }

    // Publicação ÚNICA do gauge de backlog, com o MÁXIMO da corrida inteira.
    // Nunca por tenant: o gauge é last-write-wins, e a escrita de um tenant
    // posterior sem candidatos apagava a idade de backlog do anterior — defeito
    // D10, regressão introduzida pela correção do D2. E nunca com cobertura
    // incompleta (ver `coverageComplete`).
    if (coverageComplete) {
      reportReconciliationOldestAge(oldestAgeMs ?? 0);
    }
  } catch (error) {
    exitCode = 1;
    console.error("TRILHO-B reconciliação: FALHOU", error);
  } finally {
    setDatabaseForTests(undefined);
    await flushTelemetry();
    await pool.end();
  }
  if (exitCode !== 0) process.exitCode = exitCode;
}

await main();
