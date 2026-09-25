// TRILHO B — **comando humano** de liberação de reservas retidas.
//
// Contexto: quando o gateway não informa o consumo, `settle` marca o evento como
// `usage_unknown` e **retém** a reserva. O job de reconciliação converte esses
// eventos em `reconciliation_failed` — persistido, auditável — mas **não devolve
// o orçamento**. Devolver orçamento afirmaria um consumo que nunca foi medido; por
// isso essa é uma decisão humana explícita, tomada neste comando, e não um efeito
// colateral de um cron.
//
// Garantias:
//   * **dry-run por padrão**: sem `--confirm` nada é escrito — o comando mostra o
//     que faria e sai;
//   * só libera evento que o job de reconciliação já marcou como
//     `reconciliation_failed` (CAS): um evento ainda `usage_unknown` é recusado,
//     para que a liberação nunca atropele o passo de reconciliação;
//   * `real_tokens` continua `NULL` — devolver a reserva **não** mede o consumo;
//   * idempotente: repetir o comando não devolve o mesmo valor duas vezes;
//   * cada liberação emite o evento `ai.reservation_released` com o ator.
//
// Fail-closed: `requireAdminUrl` só verifica presença e este script roda por
// `npx tsx` (sem o pre-hook do `env-guard`), então URL não-loopback é recusada
// antes de abrir conexão.
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../../src/db/schema";
import { setDatabaseForTests, type Database } from "../../src/db/client.server";
import {
  MIN_SAFE_RESERVATION_TTL_MS,
  RECONCILIATION_FAILED_OUTCOME,
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
  reservationTtlMs: MIN_SAFE_RESERVATION_TTL_MS,
};

interface CliOptions {
  tenantId: string;
  usageIds: string[];
  confirm: boolean;
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
      `${label} aponta para "${hostname}", não para loopback — recusando rodar contra host remoto`,
    );
  }
}

function parseOptions(argv: readonly string[]): CliOptions {
  const options: CliOptions = { tenantId: "", usageIds: [], confirm: false };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--tenant") {
      if (!value) throw new Error("--tenant exige um uuid");
      options.tenantId = value;
      index += 1;
    } else if (flag === "--usage-id") {
      if (!value) throw new Error("--usage-id exige um uuid");
      options.usageIds.push(value);
      index += 1;
    } else if (flag === "--confirm") {
      options.confirm = true;
    } else {
      throw new Error(`argumento desconhecido: ${flag}`);
    }
  }
  if (!options.tenantId) throw new Error("--tenant <uuid> é obrigatório");
  if (options.usageIds.length === 0) {
    throw new Error(
      "--usage-id <uuid> é obrigatório (repetível); não existe liberação em massa — cada devolução de orçamento é uma decisão revisada",
    );
  }
  return options;
}

function makeIdentity(tenantId: string, userId: string, role: string): RequestIdentity {
  return {
    userId,
    tenantId,
    roles: [role],
    correlationId: `release-unknown-reservations:${tenantId}`,
    signal: new AbortController().signal,
  };
}

interface PendingRow {
  usageId: string;
  budgetTokens: number;
  outcome: string;
  settledAt: Date | null;
}

async function readPending(
  pool: Pool,
  tenantId: string,
  usageIds: readonly string[],
): Promise<PendingRow[]> {
  const result = await pool.query<{
    usageId: string;
    budgetTokens: number;
    outcome: string | null;
    settledAt: Date | null;
  }>(
    `select
       usage_id::text as "usageId",
       budget_tokens as "budgetTokens",
       outcome,
       settled_at as "settledAt"
     from ai_usage
     where tenant_id = $1 and usage_id = any($2::uuid[])
     order by settled_at, usage_id`,
    [tenantId, usageIds],
  );
  return result.rows.map((row) => ({
    usageId: row.usageId,
    budgetTokens: row.budgetTokens,
    outcome: row.outcome ?? "(nulo)",
    settledAt: row.settledAt,
  }));
}

async function resolveTenantIdentity(
  pool: Pool,
  tenantId: string,
): Promise<{ userId: string; role: string }> {
  const result = await pool.query<{ userId: string; role: string }>(
    `select tm.user_id as "userId", tm.role
     from tenant_memberships tm
     where tm.tenant_id = $1 and tm.role in ('owner', 'admin')
     order by case tm.role when 'owner' then 0 else 1 end, tm.user_id
     limit 1`,
    [tenantId],
  );
  const row = result.rows[0];
  if (!row) throw new Error(`tenant ${tenantId} não tem membro owner/admin`);
  return row;
}

/** Mostra o estado atual dos eventos pedidos, para a decisão ser informada. */
function reportPending(pending: readonly PendingRow[]): number {
  let eligible = 0;
  if (pending.length === 0) {
    console.log("  nenhum dos usage_id informados pertence a este tenant");
    return 0;
  }
  for (const row of pending) {
    const eligibleRow = row.outcome === RECONCILIATION_FAILED_OUTCOME;
    if (eligibleRow) eligible += 1;
    console.log(
      `  usage_id=${row.usageId} outcome=${row.outcome} tokens=${row.budgetTokens} settled_at=${
        row.settledAt?.toISOString() ?? "n/a"
      } ${eligibleRow ? "[elegível para liberação]" : "[NÃO elegível — só reconciliation_failed é liberável]"}`,
    );
  }
  return eligible;
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
    const tenant = await resolveTenantIdentity(pool, options.tenantId);
    const pending = await readPending(pool, options.tenantId, options.usageIds);
    const eligible = reportPending(pending);

    if (!options.confirm) {
      console.log(
        `TRILHO-B liberação: DRY-RUN (nada foi escrito). elegíveis=${eligible}. ` +
          `Repita com --confirm para devolver as reservas elegíveis.`,
      );
      return;
    }
    if (eligible === 0) {
      console.log("TRILHO-B liberação: nada elegível — nenhuma escrita realizada");
      return;
    }

    const ledger = createBudgetLedger({
      identity: makeIdentity(options.tenantId, tenant.userId, tenant.role),
      config: BASE_CONFIG,
    });
    let released = 0;
    let releasedTokens = 0;
    for (const row of pending) {
      const result = await ledger.releaseUnknownReservation(options.tenantId, row.usageId);
      if (!result.applied) {
        console.log(
          `  usage_id=${row.usageId} não aplicou (estado mudou desde a leitura) — pulado`,
        );
        continue;
      }
      released += 1;
      releasedTokens += result.releasedTokens ?? 0;
      console.log(`  usage_id=${row.usageId} liberado: ${result.releasedTokens} tokens devolvidos`);
    }
    console.log(
      `TRILHO-B liberação: aplicada. eventos=${released} tokens_devolvidos=${releasedTokens}. ` +
        `real_tokens continua NULL — a devolução do orçamento não mede o consumo.`,
    );
  } catch (error) {
    exitCode = 1;
    console.error("TRILHO-B liberação: FALHOU", error);
  } finally {
    setDatabaseForTests(undefined);
    await pool.end();
  }
  if (exitCode !== 0) process.exitCode = exitCode;
}

await main();
