// TRILHO B — prova de banco da reconciliação de uso desconhecido.
//
// O que este script prova contra PostgreSQL real (não com dublê):
//   1. o evento `usage_unknown` que o varredor de reservas nunca alcança é
//      encontrado e marcado como `reconciliation_failed`, **de forma persistida**;
//   2. `tokens_reserved` NÃO muda no job (decisão humana: a liberação é comando
//      separado) e `real_tokens` continua `NULL` (nunca 0);
//   3. replay é no-op (INV-009 — CAS por identidade do evento);
//   4. o corte de idade é respeitado: evento recente não é tocado;
//   5. isolamento por tenant (INV-008), com controle positivo;
//   6. a liberação é guardada pelo CAS e auditável, e o replay dela é no-op;
//   7. `batchSize = 0` é RECUSADO — um lote vazio que "termina com sucesso" é o
//      mesmo fail-open silencioso que o TRILHO A fechou.
//
// Por que um script tsx e não um arquivo vitest em `src/test/**`: um vitest gated
// por loopback **pularia em silêncio** na CI (o antipadrão do `ERRATA-1` /
// `F-D2-runner-failopen`); aqui a ausência de URL **falha alto**. Mesmo padrão de
// `scripts/db/test-ai-usage-unknown.ts`.
//
// Guard: `requireAdminUrl` só verifica presença, e este script roda por `npx tsx`
// (sem o pre-hook do `env-guard`) — então ele **recusa** URL não-loopback antes de
// abrir conexão, como o seu antecessor.
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../../src/db/schema";
import { setDatabaseForTests, type Database } from "../../src/db/client.server";
import { applicationMetrics } from "../../src/instrumentation/telemetry";
import {
  MAX_RECONCILE_BATCH_SIZE,
  MIN_SAFE_RESERVATION_TTL_MS,
  RECONCILIATION_FAILED_OUTCOME,
  RESERVATION_RELEASED_OUTCOME,
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

const HOUR_MS = 60 * 60 * 1000;

interface Fixture {
  userId: string;
  tenantId: string;
}

interface CounterRow {
  tokens_reserved: number;
  in_flight: number;
}

interface UsageRow {
  usage_id: string;
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
    [userId, `TRILHO-B ${label}`, `trilho-b-${label}-${userId}@example.test`],
  );
  await pool.query(`insert into tenants (id, name, slug, kind) values ($1, $2, $3, 'personal')`, [
    tenantId,
    `TRILHO-B ${label}`,
    `trilho-b-${label}-${tenantId}`,
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
    `select tokens_reserved, in_flight
     from ai_daily_budgets where tenant_id = $1 and usage_date = $2`,
    [tenantId, utcDay()],
  );
  assert.equal(result.rows.length, 1, "o contador diário deveria existir");
  return result.rows[0]!;
}

async function readUsage(pool: Pool, tenantId: string): Promise<UsageRow[]> {
  const result = await pool.query<UsageRow>(
    `select usage_id, status, real_tokens, outcome
     from ai_usage where tenant_id = $1 order by reserved_at, usage_id`,
    [tenantId],
  );
  return result.rows;
}

/** Cria um evento `usage_unknown` genuíno: reserva e liquida sem medição. */
async function createUnknownEvent(
  ledger: ReturnType<typeof createBudgetLedger>,
  tenantId: string,
  budgetTokens: number,
): Promise<string> {
  const reservation = await ledger.reserveAtomic(tenantId, budgetTokens, {
    kind: "chat",
    roundNo: 1,
  });
  assert.equal(reservation.status, "reserved", "a reserva deveria ser aceita");
  if (reservation.status !== "reserved") throw new Error("reserva recusada");
  const settlement = await ledger.settle(
    reservation.usageId,
    { kind: "unknown", reason: "absent" },
    "success",
  );
  assert.equal(settlement.applied, true, "a liquidação desconhecida deveria aplicar");
  return reservation.usageId;
}

/** Caso 1 — o evento é encontrado, marcado e a reserva permanece retida. */
async function caseMarksFailedAndRetainsReservation(pool: Pool): Promise<void> {
  const fixture = await createFixture(pool, "marks");
  const ledger = createBudgetLedger({ identity: makeIdentity(fixture), config: BASE_CONFIG });
  const usageId = await createUnknownEvent(ledger, fixture.tenantId, 1000);

  const before = await readCounters(pool, fixture.tenantId);
  assert.equal(before.tokens_reserved, 1000, "a reserva deveria estar retida antes do job");
  assert.equal(before.in_flight, 0, "a chamada já terminou");

  // `now` adiantado em 7 h: o cutoff padrão é 6 h, então o evento entra no lote
  // sem precisar mexer no relógio do banco.
  const result = await ledger.reconcileUnknownUsage(fixture.tenantId, {
    now: new Date(Date.now() + 7 * HOUR_MS),
  });
  assert.equal(result.scannedCount, 1, "o evento deveria ser candidato");
  assert.equal(result.failedCount, 1, "o evento deveria ser marcado nesta execução");
  assert.deepEqual(result.usageIds, [usageId]);
  assert.ok(
    result.oldestAgeMs !== null && result.oldestAgeMs > 6 * HOUR_MS,
    "a idade do evento mais antigo deveria ser medida",
  );

  const usage = await readUsage(pool, fixture.tenantId);
  assert.equal(usage[0]?.outcome, RECONCILIATION_FAILED_OUTCOME);
  assert.equal(usage[0]?.status, "settled", "o status não pode mudar (CHECK restrito)");
  assert.equal(usage[0]?.real_tokens, null, "real_tokens continua NULL — nunca 0");

  const after = await readCounters(pool, fixture.tenantId);
  assert.equal(after.tokens_reserved, 1000, "o job NÃO pode tocar em tokens_reserved");
  assert.equal(after.in_flight, 0);
  console.log("TRILHO-B/1: marca reconciliation_failed + reserva retida + real_tokens NULL: OK");
}

/** Caso 2 — replay é no-op (INV-009). */
async function caseReplayIsNoOp(pool: Pool): Promise<void> {
  const fixture = await createFixture(pool, "replay");
  const ledger = createBudgetLedger({ identity: makeIdentity(fixture), config: BASE_CONFIG });
  await createUnknownEvent(ledger, fixture.tenantId, 500);
  const advanced = { now: new Date(Date.now() + 7 * HOUR_MS) };

  const first = await ledger.reconcileUnknownUsage(fixture.tenantId, advanced);
  assert.equal(first.failedCount, 1);
  const second = await ledger.reconcileUnknownUsage(fixture.tenantId, advanced);
  assert.equal(second.scannedCount, 0, "o replay não encontra mais candidatos");
  assert.equal(second.failedCount, 0, "o replay não marca nada");
  assert.deepEqual(second.usageIds, [], "o replay não reporta efeito");

  const after = await readCounters(pool, fixture.tenantId);
  assert.equal(after.tokens_reserved, 500, "o replay não move o contador");
  console.log("TRILHO-B/2: replay sem efeito (CAS por identidade do evento): OK");
}

/** Caso 3 — o corte de idade protege evento recente. */
async function caseAgeCutoffLeavesFreshEvents(pool: Pool): Promise<void> {
  const fixture = await createFixture(pool, "cutoff");
  const ledger = createBudgetLedger({ identity: makeIdentity(fixture), config: BASE_CONFIG });
  await createUnknownEvent(ledger, fixture.tenantId, 250);

  const tooYoung = await ledger.reconcileUnknownUsage(fixture.tenantId, { minAgeMs: 24 * HOUR_MS });
  assert.equal(tooYoung.scannedCount, 0, "evento mais novo que o corte não é candidato");
  assert.equal(tooYoung.oldestAgeMs, null, "sem candidato, a idade não é afirmada");
  const usage = await readUsage(pool, fixture.tenantId);
  assert.equal(usage[0]?.outcome, "usage_unknown", "o evento recente continua intacto");

  const oldEnough = await ledger.reconcileUnknownUsage(fixture.tenantId, { minAgeMs: 0 });
  assert.equal(oldEnough.failedCount, 1, "com corte zero o evento é tratado");
  assert.equal(
    (await readUsage(pool, fixture.tenantId))[0]?.outcome,
    RECONCILIATION_FAILED_OUTCOME,
  );
  console.log("TRILHO-B/3: corte de idade respeitado nas duas direções: OK");
}

/** Caso 4 — isolamento por tenant, com controle positivo e negativo. */
async function caseTenantIsolation(pool: Pool): Promise<void> {
  const tenantA = await createFixture(pool, "isol-a");
  const tenantB = await createFixture(pool, "isol-b");
  const ledgerA = createBudgetLedger({ identity: makeIdentity(tenantA), config: BASE_CONFIG });
  const ledgerB = createBudgetLedger({ identity: makeIdentity(tenantB), config: BASE_CONFIG });
  await createUnknownEvent(ledgerA, tenantA.tenantId, 100);
  await createUnknownEvent(ledgerB, tenantB.tenantId, 900);

  const advanced = { now: new Date(Date.now() + 7 * HOUR_MS) };
  const result = await ledgerA.reconcileUnknownUsage(tenantA.tenantId, advanced);
  assert.equal(result.failedCount, 1, "só o evento do tenant A deveria ser tratado");

  const usageA = await readUsage(pool, tenantA.tenantId);
  const usageB = await readUsage(pool, tenantB.tenantId);
  assert.equal(usageA[0]?.outcome, RECONCILIATION_FAILED_OUTCOME);
  assert.equal(usageB[0]?.outcome, "usage_unknown", "o tenant B não pode ser alcançado");
  assert.equal(
    (await readCounters(pool, tenantB.tenantId)).tokens_reserved,
    900,
    "o contador do tenant B não pode se mover",
  );

  // Controle negativo: uma identidade que não é do tenant é recusada ANTES de
  // tocar no banco, em vez de virar uma varredura sem filtro.
  await assert.rejects(
    () => ledgerA.reconcileUnknownUsage(tenantB.tenantId, advanced),
    /tenant/i,
    "identidade de outro tenant deveria ser recusada",
  );
  console.log("TRILHO-B/4: isolamento por tenant + recusa de identidade alheia: OK");
}

/** Caso 5 — liberação: guardada, auditável e idempotente. */
async function caseReleaseIsGuardedAndAuditable(pool: Pool): Promise<void> {
  const fixture = await createFixture(pool, "release");
  const ledger = createBudgetLedger({ identity: makeIdentity(fixture), config: BASE_CONFIG });
  const usageId = await createUnknownEvent(ledger, fixture.tenantId, 700);

  // Ainda `usage_unknown` (não reconciliado): a liberação NÃO pode aplicar. Este é
  // o controle que prova que o comando humano não atropela o passo de reconciliação.
  const premature = await ledger.releaseUnknownReservation(fixture.tenantId, usageId);
  assert.equal(premature.applied, false, "não se libera um evento ainda não reconciliado");
  assert.equal((await readCounters(pool, fixture.tenantId)).tokens_reserved, 700);

  await ledger.reconcileUnknownUsage(fixture.tenantId, { now: new Date(Date.now() + 7 * HOUR_MS) });

  const released = await ledger.releaseUnknownReservation(fixture.tenantId, usageId);
  assert.equal(released.applied, true, "a liberação deveria aplicar após a reconciliação");
  assert.equal(released.releasedTokens, 700, "o valor devolvido é o que estava reservado");

  const usage = await readUsage(pool, fixture.tenantId);
  assert.equal(usage[0]?.outcome, RESERVATION_RELEASED_OUTCOME);
  assert.equal(usage[0]?.real_tokens, null, "devolver a reserva NÃO mede o consumo");
  const after = await readCounters(pool, fixture.tenantId);
  assert.equal(after.tokens_reserved, 0, "a reserva volta ao contador");
  assert.equal(after.in_flight, 0, "in_flight já havia sido liberado no settle");

  const replay = await ledger.releaseUnknownReservation(fixture.tenantId, usageId);
  assert.equal(replay.applied, false, "replay da liberação é no-op");
  assert.equal(
    (await readCounters(pool, fixture.tenantId)).tokens_reserved,
    0,
    "replay não devolve duas vezes",
  );
  console.log("TRILHO-B/5: liberação guardada por CAS, auditável e idempotente: OK");
}

/** Caso 6 — lote fora da faixa é recusado (anti-fail-open: nem vazio, nem acima
 * do teto) e as métricas são emitidas. */
async function caseBatchZeroRefusedAndMetricsEmitted(pool: Pool): Promise<void> {
  const fixture = await createFixture(pool, "guard");
  const ledger = createBudgetLedger({ identity: makeIdentity(fixture), config: BASE_CONFIG });
  await createUnknownEvent(ledger, fixture.tenantId, 100);

  // Os instrumentos de `applicationMetrics` são os singletons noop de
  // `@opentelemetry/api` (obtidos no import do módulo, quando ainda não há
  // provider registrado — defeito D7, WP `F-otel-provider-order`), e
  // `@opentelemetry/api` NÃO tem proxy de métrica: o único proxy da API é o de
  // trace. Medido: atribuir a `.add` do instrumento não teve efeito — a primeira
  // versão deste caso falhou contra o banco real com `0 !== 1` mesmo com o evento
  // estruturado já emitido. O que funciona (e é medido) é substituir o
  // INSTRUMENTO INTEIRO no objeto `applicationMetrics`, que é um literal
  // mutável. O motivo exato de a atribuição em `.add` não surtir efeito não foi
  // estabelecido por leitura — o código anterior deste teste não está na árvore —
  // então não afirme um mecanismo que ninguém verificou.
  const originalTotal = applicationMetrics.aiReconciliationTotal;
  const originalFailed = applicationMetrics.aiReconciliationFailed;
  let totalCalls = 0;
  let failedCalls = 0;
  applicationMetrics.aiReconciliationTotal = {
    add: () => {
      totalCalls += 1;
    },
  } as unknown as typeof applicationMetrics.aiReconciliationTotal;
  applicationMetrics.aiReconciliationFailed = {
    add: () => {
      failedCalls += 1;
    },
  } as unknown as typeof applicationMetrics.aiReconciliationFailed;
  try {
    await assert.rejects(
      () => ledger.reconcileUnknownUsage(fixture.tenantId, { batchSize: 0 }),
      /batchSize/,
      "lote zero deveria ser recusado em vez de terminar com sucesso sem tratar nada",
    );
    assert.equal(
      (await readUsage(pool, fixture.tenantId))[0]?.outcome,
      "usage_unknown",
      "a recusa não pode ter marcado nada",
    );

    // D3 do adversarial: o teto era aparado em silêncio (`Math.min`) na
    // biblioteca enquanto o CLI o recusava — dois contratos para a mesma opção.
    await assert.rejects(
      () =>
        ledger.reconcileUnknownUsage(fixture.tenantId, {
          batchSize: MAX_RECONCILE_BATCH_SIZE + 1,
        }),
      /batchSize/,
      "lote acima do teto deveria ser recusado, não aparado em silêncio",
    );
    assert.equal(
      (await readUsage(pool, fixture.tenantId))[0]?.outcome,
      "usage_unknown",
      "a recusa por teto também não pode ter marcado nada",
    );

    const result = await ledger.reconcileUnknownUsage(fixture.tenantId, {
      now: new Date(Date.now() + 7 * HOUR_MS),
    });
    assert.equal(result.failedCount, 1);
    assert.equal(totalCalls, 1, "app.ai.reconciliation_total deve ser emitido por linha tratada");
    assert.equal(failedCalls, 1, "app.ai.reconciliation_failed deve ser emitido por falha");
  } finally {
    applicationMetrics.aiReconciliationTotal = originalTotal;
    applicationMetrics.aiReconciliationFailed = originalFailed;
  }
  console.log("TRILHO-B/6: lote vazio e lote acima do teto recusados + métricas emitidas: OK");
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
    await caseMarksFailedAndRetainsReservation(pool);
    await caseReplayIsNoOp(pool);
    await caseAgeCutoffLeavesFreshEvents(pool);
    await caseTenantIsolation(pool);
    await caseReleaseIsGuardedAndAuditable(pool);
    await caseBatchZeroRefusedAndMetricsEmitted(pool);
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
  console.log("TRILHO-B: prova de banco da reconciliação concluída (6 casos)");
}

await main();
