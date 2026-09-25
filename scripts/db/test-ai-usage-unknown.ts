// INV-006 (variante B) — prova de banco do caminho **desconhecido**.
//
// A variante B está provada em unidade com dublê de transação; o que falta é a prova
// contra PostgreSQL real: que `ai_usage.real_tokens` aceita `NULL` pelo driver, que a
// CHECK `is null or >= 0` não bloqueia a linha e que o `settle` grava o fato sem lançar
// — além de a reserva ficar **retida** em vez de liberada como zero.
//
// Por que um script tsx e não um arquivo vitest em `src/test/**`:
//   1. `package.json` (encadeamento do `db:test`) é arquivo em contenção com o trilho B
//      do ciclo 6 — não é tocado nesta rodada;
//   2. um vitest gated por loopback **pularia em silêncio** na CI (o antipadrão do
//      `ERRATA-1`/`F-D2-runner-failopen`); aqui a ausência de URL **falha alto**;
//   3. `scripts/db/test-ai-budget.ts` é trilho A (congelado) — não é editado.
//
// Guard: `requireAdminUrl` só verifica presença. Como este script é invocado por
// `npx tsx` (sem o pre-hook do `env-guard`), ele **recusa** qualquer URL que não seja
// loopback **antes** de abrir conexão.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../../src/db/schema";
import { setDatabaseForTests, type Database } from "../../src/db/client.server";
import {
  MIN_SAFE_RESERVATION_TTL_MS,
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

interface Fixture {
  userId: string;
  tenantId: string;
}

interface CounterRow {
  input_tokens: number;
  output_tokens: number;
  tokens_reserved: number;
  in_flight: number;
}

interface UsageRow {
  status: string;
  real_tokens: number | null;
  outcome: string | null;
}

const createdFixtures: Fixture[] = [];

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

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function makeIdentity(fixture: Fixture): RequestIdentity {
  return {
    userId: fixture.userId,
    tenantId: fixture.tenantId,
    roles: ["owner"],
    correlationId: randomUUID(),
    signal: new AbortController().signal,
  };
}

async function createFixture(pool: Pool, label: string): Promise<Fixture> {
  const userId = randomUUID();
  const tenantId = randomUUID();
  await pool.query(
    `insert into users (id, name, email, email_verified) values ($1, $2, $3, true)`,
    [userId, `INV-006 ${label}`, `inv006-${label}-${userId}@example.test`],
  );
  await pool.query(`insert into tenants (id, name, slug, kind) values ($1, $2, $3, 'personal')`, [
    tenantId,
    `INV-006 ${label}`,
    `inv006-${label}-${tenantId}`,
  ]);
  await pool.query(
    `insert into tenant_memberships (tenant_id, user_id, role) values ($1, $2, 'owner')`,
    [tenantId, userId],
  );
  const fixture = { userId, tenantId };
  createdFixtures.push(fixture);
  return fixture;
}

async function readCounters(pool: Pool, tenantId: string): Promise<CounterRow> {
  const result = await pool.query<CounterRow>(
    `select input_tokens, output_tokens, tokens_reserved, in_flight
     from ai_daily_budgets where tenant_id = $1 and usage_date = $2`,
    [tenantId, utcDay()],
  );
  assert.equal(result.rows.length, 1, "o contador diário deveria existir");
  return result.rows[0]!;
}

async function readUsage(pool: Pool, tenantId: string): Promise<UsageRow[]> {
  const result = await pool.query<UsageRow>(
    `select status, real_tokens, outcome from ai_usage where tenant_id = $1 order by reserved_at, usage_id`,
    [tenantId],
  );
  return result.rows;
}

/** Caso 1 — desconhecido: NULL persistido, reserva retida, contadores intocados. */
async function caseUnknown(pool: Pool): Promise<void> {
  const fixture = await createFixture(pool, "unknown");
  const ledger = createBudgetLedger({ identity: makeIdentity(fixture), config: BASE_CONFIG });

  const reservation = await ledger.reserveAtomic(fixture.tenantId, 1000, {
    kind: "chat",
    roundNo: 1,
  });
  assert.equal(reservation.status, "reserved");
  if (reservation.status !== "reserved") return;

  const before = await readCounters(pool, fixture.tenantId);
  assert.equal(before.tokens_reserved, 1000, "a reserva deveria estar registrada");
  assert.equal(before.in_flight, 1, "a chamada deveria estar em voo");

  const settlement = await ledger.settle(
    reservation.usageId,
    { kind: "unknown", reason: "absent" },
    "success",
  );
  assert.equal(settlement.applied, true, "a liquidação deveria aplicar");

  const usage = await readUsage(pool, fixture.tenantId);
  assert.equal(usage.length, 1);
  assert.equal(usage[0]?.status, "settled");
  assert.equal(usage[0]?.real_tokens, null, "real_tokens deve ser NULL — nunca 0");
  assert.equal(usage[0]?.outcome, "usage_unknown");

  const after = await readCounters(pool, fixture.tenantId);
  assert.equal(after.tokens_reserved, 1000, "a reserva deve permanecer RETIDA (não liberada)");
  assert.equal(after.input_tokens, 0, "contador de entrada não pode receber zero desconhecido");
  assert.equal(after.output_tokens, 0, "contador de saída não pode receber zero desconhecido");
  assert.equal(after.in_flight, 0, "a chamada terminou: não está mais em voo");
  console.log("INV-006/desconhecido: real_tokens NULL + reserva retida + in_flight liberado: OK");
}

/** Caso 2 — controle conhecido via TokenUsage: mede, libera e conta. */
async function caseKnown(pool: Pool): Promise<void> {
  const fixture = await createFixture(pool, "known");
  const ledger = createBudgetLedger({ identity: makeIdentity(fixture), config: BASE_CONFIG });

  const reservation = await ledger.reserveAtomic(fixture.tenantId, 200, {
    kind: "chat",
    roundNo: 1,
  });
  assert.equal(reservation.status, "reserved");
  if (reservation.status !== "reserved") return;

  await ledger.settle(
    reservation.usageId,
    { kind: "known", inputTokens: 120, outputTokens: 35 },
    "success",
  );

  const usage = await readUsage(pool, fixture.tenantId);
  assert.equal(usage[0]?.real_tokens, 155);
  assert.equal(usage[0]?.outcome, "success");

  const after = await readCounters(pool, fixture.tenantId);
  assert.equal(after.tokens_reserved, 0, "uso conhecido libera a reserva");
  assert.equal(after.input_tokens, 120);
  assert.equal(after.output_tokens, 35);
  assert.equal(after.in_flight, 0);
  console.log("INV-006/conhecido: real_tokens 155 + reserva liberada + contadores: OK");
}

/** Caso 3 — regressão: o caminho numérico legado segue idêntico. */
async function caseNumericRegression(pool: Pool): Promise<void> {
  const fixture = await createFixture(pool, "numeric");
  const ledger = createBudgetLedger({ identity: makeIdentity(fixture), config: BASE_CONFIG });

  const reservation = await ledger.reserveAtomic(fixture.tenantId, 100, {
    kind: "model",
    roundNo: 0,
  });
  assert.equal(reservation.status, "reserved");
  if (reservation.status !== "reserved") return;

  await ledger.settle(reservation.usageId, 7, "success", { inputTokens: 3, outputTokens: 4 });

  const usage = await readUsage(pool, fixture.tenantId);
  assert.equal(usage[0]?.real_tokens, 7);
  assert.equal(usage[0]?.outcome, "success");

  const after = await readCounters(pool, fixture.tenantId);
  assert.equal(after.tokens_reserved, 0);
  assert.equal(after.input_tokens, 3);
  assert.equal(after.output_tokens, 4);
  console.log("INV-006/regressão numérica: caminho legado inalterado: OK");
}

async function main(): Promise<void> {
  const adminUrl = requireAdminUrl();
  assertLoopback("DATABASE_ADMIN_URL", adminUrl);
  assertLoopback("DATABASE_URL", process.env.DATABASE_URL);
  assertLoopback("DATABASE_URL_UNPOOLED", process.env.DATABASE_URL_UNPOOLED);

  const pool = new Pool({ connectionString: adminUrl, max: 4 });
  const database = drizzle({ client: pool, schema });
  setDatabaseForTests(database as unknown as Database);
  try {
    await caseUnknown(pool);
    await caseKnown(pool);
    await caseNumericRegression(pool);
  } finally {
    const tenantIds = createdFixtures.map((fixture) => fixture.tenantId);
    const userIds = createdFixtures.map((fixture) => fixture.userId);
    if (tenantIds.length > 0) {
      await pool.query("delete from tenants where id = any($1::uuid[])", [tenantIds]);
      await pool.query("delete from users where id = any($1::text[])", [userIds]);
    }
    setDatabaseForTests(undefined);
    await pool.end();
  }
  console.log("INV-006: prova de banco do caminho desconhecido concluída (3 casos)");
}

await main();
