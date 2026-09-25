import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { Pool } from "pg";

/**
 * DB-01 — purge dos dados de fixture do Neon production.
 *
 * Marcador de fixture: e-mail terminando em `@preco-que-da.test` (domínio
 * reservado RFC 2606, impossível para usuário real). Todos os dados de teste
 * pendem desses usuários via FK (tenant pessoal / Tenant E2E).
 *
 * Fail-closed: aborta se existir QUALQUER usuário fora do marcador — após o
 * purge, conta alguma em produção significa tráfego real, e reexecutar este
 * script com tráfego real é proibido (a guarda falha antes de qualquer escrita).
 *
 * Padrão é dry-run (read-only). Escrita somente com PURGE_APPLY=true.
 */

export const FIXTURE_EMAIL_DOMAIN = "@preco-que-da.test";

export function isFixtureEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(FIXTURE_EMAIL_DOMAIN);
}

/**
 * Trilha de memória (`ai_memory_*`), filhos antes do pai. É a ordem FK-safe para
 * apagar a trilha antes de `tenant_memberships`/`tenants`: `ai_memory_access_log`
 * é `ON DELETE RESTRICT` para memberships (migration 0019), então sem esta
 * limpeza qualquer purga de membro falha alto com 23503. Exportada para os
 * purgadores que mantêm lista própria (E2E, EXPLAIN e suítes de banco).
 */
export const MEMORY_TRAIL_TABLES = [
  "ai_memory_access_log",
  "ai_memory_conflicts",
  "ai_memory_versions",
  "ai_memory_sources",
  "ai_memories",
] as const;

/** Tabelas tenant-scoped, filhos antes dos pais (espelha scripts/e2e/seed-auth.ts). */
export const TENANT_SCOPED_TABLES = [
  ...MEMORY_TRAIL_TABLES,
  "backfill_work_items",
  "backfill_checkpoints",
  "outbox_consumptions",
  "outbox_events",
  "chat_messages",
  "chat_conversations",
  "tool_executions",
  "idempotency_records",
  "audit_events",
  "ai_daily_budgets",
  "ai_usage",
  "calculation_snapshots",
  "sales_items",
  "sales",
  "simulations",
  "purchase_price_history",
  "market_prices",
  "sales_fees",
  "product_packaging",
  "product_ingredients",
  "expenses",
  "products",
  "profiles",
] as const;

export interface PurgePlan {
  fixtureUsers: { id: string; email: string }[];
  fixtureTenantIds: string[];
  nonFixtureUserCount: number;
}

export interface DeleteStep {
  label: string;
  sql: string;
  param: "tenants" | "users" | "domain" | null;
}

/** Sequência completa de deletes, na ordem de execução (FK-safe). */
export function buildDeleteSteps(): DeleteStep[] {
  const steps: DeleteStep[] = TENANT_SCOPED_TABLES.map((table) => ({
    label: table,
    // Lista FIXA de tabelas (sem input externo) + ids parametrizados com cast
    // explícito (uuid[]/text[]) — sem o cast o PG não infere o tipo de $1.
    // pi-lens-ignore: no-sql-in-code
    sql: `delete from ${table} where tenant_id = any($1::uuid[])`,
    param: "tenants",
  }));
  steps.push(
    {
      label: "tenant_memberships",
      sql: "delete from tenant_memberships where tenant_id = any($1::uuid[])",
      param: "tenants",
    },
    {
      label: "sessions",
      sql: "delete from sessions where user_id = any($1::text[])",
      param: "users",
    },
    {
      label: "accounts",
      sql: "delete from accounts where user_id = any($1::text[])",
      param: "users",
    },
    {
      label: "verifications",
      sql: "delete from verifications where identifier ilike '%' || $1",
      param: "domain",
    },
    {
      label: "tenants",
      sql: "delete from tenants where id = any($1::uuid[])",
      param: "tenants",
    },
    { label: "users", sql: "delete from users where id = any($1::text[])", param: "users" },
    {
      // rate_limits é global (sem tenant/user); só é seguro porque a guarda
      // fail-closed prova zero usuários não-fixture (janelas de 60s do E2E).
      label: "rate_limits",
      sql: "delete from rate_limits",
      param: null,
    },
  );
  return steps;
}

export function assertPurgeAllowed(plan: PurgePlan): void {
  if (plan.nonFixtureUserCount > 0) {
    throw new Error(
      `PURGE ABORTADO: ${plan.nonFixtureUserCount} usuário(s) fora do marcador de fixture ` +
        `(${FIXTURE_EMAIL_DOMAIN}). Com tráfego real, este script é proibido.`,
    );
  }
  for (const user of plan.fixtureUsers) {
    if (!isFixtureEmail(user.email)) {
      throw new Error(`PURGE ABORTADO: usuário ${user.id} fora do marcador (${user.email}).`);
    }
  }
}

async function loadPlan(pool: Pool): Promise<PurgePlan> {
  const users = await pool.query<{ id: string; email: string }>(
    "select id, email from users where email ilike '%' || $1 order by created_at",
    [FIXTURE_EMAIL_DOMAIN],
  );
  const nonFixture = await pool.query<{ n: string }>(
    "select count(*)::text as n from users where email not ilike '%' || $1",
    [FIXTURE_EMAIL_DOMAIN],
  );
  const userIds = users.rows.map((row) => row.id);
  const tenants = userIds.length
    ? await pool.query<{ tenant_id: string }>(
        "select distinct tenant_id from tenant_memberships where user_id = any($1)",
        [userIds],
      )
    : { rows: [] };
  return {
    fixtureUsers: users.rows,
    fixtureTenantIds: tenants.rows.map((row) => row.tenant_id),
    nonFixtureUserCount: Number(nonFixture.rows[0]?.n ?? "0"),
  };
}

function paramsFor(step: DeleteStep, plan: PurgePlan): unknown[] {
  if (step.param === "tenants") return [plan.fixtureTenantIds];
  if (step.param === "users") return [plan.fixtureUsers.map((user) => user.id)];
  if (step.param === "domain") return [FIXTURE_EMAIL_DOMAIN];
  return [];
}

async function main(): Promise<void> {
  const adminUrl = process.env.DATABASE_ADMIN_URL;
  if (!adminUrl) {
    console.error(JSON.stringify({ error: "DATABASE_ADMIN_URL é obrigatória" }));
    process.exit(2);
  }
  const apply = process.env.PURGE_APPLY === "true";
  const local = ["127.0.0.1", "localhost", "::1"].includes(new URL(adminUrl).hostname);
  const pool = new Pool({
    connectionString: adminUrl,
    ssl: local ? false : { rejectUnauthorized: true },
    max: 1,
  });
  const startedAt = new Date().toISOString();
  try {
    const plan = await loadPlan(pool);
    assertPurgeAllowed(plan);
    const steps = buildDeleteSteps();
    const deleted: Record<string, number> = {};
    if (apply) {
      const client = await pool.connect();
      try {
        await client.query("begin");
        for (const step of steps) {
          const result = await client.query(step.sql, paramsFor(step, plan));
          deleted[step.label] = result.rowCount ?? 0;
        }
        await client.query("commit");
      } catch (error) {
        await client.query("rollback");
        throw error;
      } finally {
        client.release();
      }
    }
    const post = await loadPlan(pool);
    const remaining = await pool.query<{ n: string }>("select count(*)::text as n from users");
    const output = {
      check: "db:purge-fixtures",
      mode: apply ? "APPLY" : "DRY-RUN",
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      fixture_marker: FIXTURE_EMAIL_DOMAIN,
      fixture_users: plan.fixtureUsers,
      fixture_tenant_ids: plan.fixtureTenantIds,
      non_fixture_user_count: plan.nonFixtureUserCount,
      deleted,
      post: {
        fixture_users_remaining: post.fixtureUsers.length,
        fixture_tenants_remaining: post.fixtureTenantIds.length,
        users_total_remaining: Number(remaining.rows[0]?.n ?? "0"),
      },
    };
    console.log(JSON.stringify(output, null, 2));
    if (apply && (post.fixtureUsers.length > 0 || post.fixtureTenantIds.length > 0)) {
      process.exitCode = 1;
    }
  } finally {
    await pool.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error: unknown) => {
    console.error(JSON.stringify({ check: "db:purge-fixtures", error: String(error) }));
    process.exit(2);
  });
}
