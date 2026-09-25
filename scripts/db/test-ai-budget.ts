import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../../src/db/schema";
import {
  setDatabaseForTests,
  transactionManager as defaultTransactionManager,
  type Database,
  type TransactionManager,
} from "../../src/db/client.server";
import { ApplicationError } from "../../src/lib/api-error";
import {
  budgetConfigFromEnv,
  createBudgetLedger,
  MIN_SAFE_RESERVATION_TTL_MS,
  type BudgetLedger,
  type BudgetLedgerConfig,
  type ReserveResult,
  type SettlementResult,
  type SweepResult,
} from "../../src/lib/ai/budget-ledger.server";
import {
  executeSendChatMessage,
  type ChatExecutionDependencies,
} from "../../src/lib/chat-execution.server";
import type { RequestIdentity } from "../../src/lib/request-context";
import { requireAdminUrl } from "./migrate";
import { MEMORY_TRAIL_TABLES } from "./purge-fixtures";

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
  chat_count: number;
  model_call_count: number;
  tool_call_count: number;
  input_tokens: number;
  output_tokens: number;
  tokens_reserved: number;
  in_flight: number;
}

interface UsageRow {
  usage_id: string;
  status: string;
  budget_tokens: number;
  real_tokens: number | null;
  outcome: string | null;
}

const createdFixtures: Fixture[] = [];

function testConfig(overrides: Partial<BudgetLedgerConfig> = {}): BudgetLedgerConfig {
  return { ...BASE_CONFIG, ...overrides };
}

function utcDay(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

function makeIdentity(fixture: Fixture, signal = new AbortController().signal): RequestIdentity {
  return {
    userId: fixture.userId,
    tenantId: fixture.tenantId,
    roles: ["owner"],
    correlationId: randomUUID(),
    signal,
  };
}

function modelResponse(content = "ok", promptTokens = 2, completionTokens = 3) {
  return {
    choices: [{ message: { content } }],
    usage: { prompt_tokens: promptTokens, completion_tokens: completionTokens },
  };
}

function sleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

const E6_MAX_DELAY_MS = 10_000;

function e6DelayFromEnv(name: string, fallback: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed >= 0 && parsed <= E6_MAX_DELAY_MS ? parsed : fallback;
}

async function createFixture(pool: Pool, label: string): Promise<Fixture> {
  const userId = randomUUID();
  const tenantId = randomUUID();
  const email = `${label}-${userId}@example.test`;
  await pool.query(
    `insert into users (id, name, email, email_verified)
     values ($1, $2, $3, true)`,
    [userId, `AI budget ${label}`, email],
  );
  await pool.query(
    `insert into tenants (id, name, slug, kind)
     values ($1, $2, $3, 'personal')`,
    [tenantId, `AI budget ${label}`, `ai-budget-${label}-${tenantId}`],
  );
  await pool.query(
    `insert into tenant_memberships (tenant_id, user_id, role)
     values ($1, $2, 'owner')`,
    [tenantId, userId],
  );
  const fixture = { userId, tenantId };
  createdFixtures.push(fixture);
  return fixture;
}

async function readCounters(
  pool: Pool,
  tenantId: string,
  usageDate = utcDay(),
): Promise<CounterRow> {
  const result = await pool.query<CounterRow>(
    `select chat_count, model_call_count, tool_call_count, input_tokens,
            output_tokens, tokens_reserved, in_flight
     from ai_daily_budgets
     where tenant_id = $1 and usage_date = $2`,
    [tenantId, usageDate],
  );
  assert.equal(result.rows.length, 1, "o contador diário deveria existir");
  return result.rows[0]!;
}

async function readUsage(pool: Pool, tenantId: string): Promise<UsageRow[]> {
  const result = await pool.query<UsageRow>(
    `select usage_id::text as usage_id, status, budget_tokens, real_tokens, outcome
     from ai_usage
     where tenant_id = $1
     order by reserved_at, usage_id`,
    [tenantId],
  );
  return result.rows;
}

function assertApiError(error: unknown, code: ApplicationError["code"]): void {
  assert.ok(
    error instanceof ApplicationError,
    `erro deveria ser ApplicationError: ${String(error)}`,
  );
  assert.equal(error.code, code);
}

async function runE1(pool: Pool): Promise<void> {
  const fixture = await createFixture(pool, "e1");
  const config = testConfig({ dailyModelCallLimit: 1, inFlightLimit: 100 });
  let gatewayCalls = 0;
  let activeCalls = 0;
  let peakActiveCalls = 0;
  const modelCaller: NonNullable<ChatExecutionDependencies["modelCaller"]> = async () => {
    gatewayCalls += 1;
    activeCalls += 1;
    peakActiveCalls = Math.max(peakActiveCalls, activeCalls);
    try {
      await sleep(150);
      return modelResponse();
    } finally {
      activeCalls -= 1;
    }
  };

  const results = await Promise.allSettled(
    Array.from({ length: 20 }, (_, index) =>
      executeSendChatMessage({ message: `e1 concurrent ${index}` }, makeIdentity(fixture), {
        budgetConfig: config,
        modelCaller,
      }),
    ),
  );
  const successes = results.filter((result) => result.status === "fulfilled");
  const quotaRejects = results.filter(
    (result) =>
      result.status === "rejected" &&
      result.reason instanceof ApplicationError &&
      result.reason.code === "AI_QUOTA",
  );
  assert.equal(gatewayCalls, 1, "E1: somente uma chamada deve alcançar o gateway");
  assert.equal(peakActiveCalls, 1, "E1: o limite de chamadas do tenant é 1");
  assert.equal(successes.length, 1, "E1: exatamente uma chamada deve concluir");
  assert.equal(quotaRejects.length, 19, "E1: as demais respostas devem ser AI_QUOTA");
  assert.equal(results.length, successes.length + quotaRejects.length);
  const counters = await readCounters(pool, fixture.tenantId);
  assert.deepEqual(
    counters,
    {
      chat_count: 20,
      model_call_count: 1,
      tool_call_count: 0,
      input_tokens: 2,
      output_tokens: 3,
      tokens_reserved: 0,
      in_flight: 0,
    },
    "E1: invariantes finais do contador",
  );
  const usage = await readUsage(pool, fixture.tenantId);
  assert.equal(usage.length, 1);
  assert.equal(usage[0]?.status, "settled");
  console.log("T1/E1: reserva atômica sob 20 concorrentes: OK");
}

async function runE2(pool: Pool): Promise<void> {
  const fixture = await createFixture(pool, "e2");
  const now = new Date();
  const ledger = createBudgetLedger({ identity: makeIdentity(fixture), config: testConfig() });
  const reservation = await ledger.reserveAtomic(fixture.tenantId, 100, {
    kind: "model",
    roundNo: 0,
    now,
  });
  assert.equal(reservation.status, "reserved");
  if (reservation.status !== "reserved") return;
  const first = await ledger.settle(reservation.usageId, 7, "success", {
    now: new Date(now.getTime() + 10),
    inputTokens: 3,
    outputTokens: 4,
  });
  assert.equal(first.applied, true);
  const countersAfterFirst = await readCounters(pool, fixture.tenantId, utcDay(now));
  const replay = await ledger.settle(reservation.usageId, 7, "success", {
    now: new Date(now.getTime() + 20),
    inputTokens: 3,
    outputTokens: 4,
  });
  assert.equal(replay.applied, false);
  const countersAfterReplay = await readCounters(pool, fixture.tenantId, utcDay(now));
  assert.deepEqual(
    countersAfterReplay,
    countersAfterFirst,
    "T2: replay não pode alterar contadores",
  );
  const secondReservation = await ledger.reserveAtomic(fixture.tenantId, 100, {
    kind: "model",
    roundNo: 1,
    now: new Date(now.getTime() + 30),
  });
  assert.equal(secondReservation.status, "reserved");
  if (secondReservation.status === "reserved") {
    let transactionAttempts = 0;
    const flakyTransactionManager: TransactionManager = {
      async run(identity, operation) {
        transactionAttempts += 1;
        const result = await defaultTransactionManager.run(identity, operation);
        if (transactionAttempts === 1) throw new Error("simulated_post_commit_failure");
        return result;
      },
    };
    const retryLedger = createBudgetLedger({
      identity: makeIdentity(fixture),
      config: testConfig(),
      transactionManager: flakyTransactionManager,
    });
    const retry = await retryLedger.settle(secondReservation.usageId, 0, "success");
    assert.equal(
      transactionAttempts,
      2,
      "T2: settlement deve ser repetido uma vez após falha pós-commit",
    );
    assert.equal(retry.applied, false, "T2: o replay pós-commit deve ser idempotente");
  }
  const countersAfterRetry = await readCounters(pool, fixture.tenantId, utcDay(now));
  assert.equal(countersAfterRetry.tokens_reserved, 0);
  assert.equal(countersAfterRetry.in_flight, 0);
  console.log("T2/E2: settlement exatamente-uma-vez: OK");
}

async function runE3(pool: Pool): Promise<void> {
  const fixture = await createFixture(pool, "e3");
  const config = testConfig({ inFlightLimit: 1 });
  const modelCaller: NonNullable<ChatExecutionDependencies["modelCaller"]> = async () => {
    throw new ApplicationError("AI_TIMEOUT");
  };
  await assert.rejects(
    executeSendChatMessage({ message: "e3 timeout" }, makeIdentity(fixture), {
      budgetConfig: config,
      modelCaller,
    }),
    (error: unknown) => {
      assertApiError(error, "AI_TIMEOUT");
      return true;
    },
  );
  const counters = await readCounters(pool, fixture.tenantId);
  assert.equal(counters.model_call_count, 1);
  assert.equal(counters.tokens_reserved, 0);
  assert.equal(counters.in_flight, 0);
  const usage = await readUsage(pool, fixture.tenantId);
  assert.deepEqual(
    usage.map(({ status, outcome, real_tokens }) => ({ status, outcome, real_tokens })),
    [{ status: "settled", outcome: "error_ai_timeout", real_tokens: 0 }],
  );
  console.log("T3/E3: timeout liquida a reserva e libera in_flight: OK");
}

async function runE4(pool: Pool): Promise<void> {
  const fixture = await createFixture(pool, "e4");
  const abortController = new AbortController();
  let resolveStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const modelCaller: NonNullable<ChatExecutionDependencies["modelCaller"]> = async (
    _messages,
    _tools,
    signal,
  ) => {
    resolveStarted();
    return new Promise<never>((_resolve, reject) => {
      const fail = () => reject(new ApplicationError("AI_TIMEOUT"));
      if (signal.aborted) fail();
      else signal.addEventListener("abort", fail, { once: true });
    });
  };
  const pending = executeSendChatMessage(
    { message: "e4 abort" },
    makeIdentity(fixture, abortController.signal),
    { budgetConfig: testConfig({ inFlightLimit: 1 }), modelCaller },
  );
  await started;
  abortController.abort(new ApplicationError("AI_TIMEOUT"));
  await assert.rejects(pending, (error: unknown) => {
    assertApiError(error, "AI_TIMEOUT");
    return true;
  });
  const counters = await readCounters(pool, fixture.tenantId);
  assert.equal(counters.tokens_reserved, 0);
  assert.equal(counters.in_flight, 0);
  console.log("T4/E4: abort liquida a reserva no finally: OK");
}

async function runE5(pool: Pool): Promise<void> {
  const fixture = await createFixture(pool, "e5");
  const config = testConfig({ dailyModelCallLimit: 5, inFlightLimit: 1 });
  let modelCalls = 0;
  let toolCalls = 0;
  const modelCaller: NonNullable<ChatExecutionDependencies["modelCaller"]> = async () => {
    modelCalls += 1;
    if (modelCalls <= 2) {
      return {
        choices: [
          {
            message: {
              content: null,
              tool_calls: [
                {
                  id: `e5-tool-${modelCalls}`,
                  function: { name: "add_expense", arguments: "{}" },
                },
              ],
            },
          },
        ],
        usage: { prompt_tokens: 2, completion_tokens: 3 },
      };
    }
    return modelResponse("e5 final");
  };
  const toolRunner: NonNullable<ChatExecutionDependencies["toolRunner"]> = async () => {
    toolCalls += 1;
    return { ok: true, output: { result: { accepted: true } }, replayed: false };
  };
  const result = await executeSendChatMessage(
    { message: "e5 tool rounds" },
    makeIdentity(fixture),
    { budgetConfig: config, modelCaller, toolRunner },
  );
  assert.equal(result.content, "e5 final");
  assert.equal(modelCalls, 3);
  assert.equal(toolCalls, 2);
  const counters = await readCounters(pool, fixture.tenantId);
  assert.equal(counters.model_call_count, 3);
  assert.equal(counters.tool_call_count, 2);
  assert.equal(counters.tokens_reserved, 0);
  assert.equal(counters.in_flight, 0);
  assert.equal((await readUsage(pool, fixture.tenantId)).length, 3);
  console.log("T5/E5: reserva/liquidação independente por tool round: OK");
}

async function runE6(pool: Pool): Promise<void> {
  const fixture = await createFixture(pool, "e6");
  const config = testConfig({ dailyModelCallLimit: 20, inFlightLimit: 2 });
  const holdMs = e6DelayFromEnv("E6_HOLD_MS", 300);
  const queueMs = e6DelayFromEnv("E6_QUEUE_MS", 0);
  const requestCount = 8;
  const sharedLedger = createBudgetLedger({ identity: makeIdentity(fixture), config });
  let reserveAttempts = 0;
  let completedReserveAttempts = 0;
  let releaseReservations!: () => void;
  const allReserveAttemptsCompleted = new Promise<void>((resolve) => {
    releaseReservations = resolve;
  });
  const gatedLedger: BudgetLedger = {
    ...sharedLedger,
    async reserveAtomic(tenantId, budgetTokens, options): Promise<ReserveResult> {
      reserveAttempts += 1;
      let result: ReserveResult;
      try {
        result = await sharedLedger.reserveAtomic(tenantId, budgetTokens, options);
      } finally {
        completedReserveAttempts += 1;
        if (completedReserveAttempts === requestCount) releaseReservations();
      }
      if (result.status === "reserved") await allReserveAttemptsCompleted;
      return result;
    },
  };
  let gatewayCalls = 0;
  let activeCalls = 0;
  let peakActiveCalls = 0;
  const modelCaller: NonNullable<ChatExecutionDependencies["modelCaller"]> = async () => {
    gatewayCalls += 1;
    activeCalls += 1;
    peakActiveCalls = Math.max(peakActiveCalls, activeCalls);
    try {
      await sleep(holdMs);
      return modelResponse("e6");
    } finally {
      activeCalls -= 1;
    }
  };
  const results = await Promise.allSettled(
    Array.from({ length: requestCount }, (_, index) =>
      (async () => {
        if (queueMs > 0) await sleep(index * queueMs);
        return executeSendChatMessage({ message: `e6 in-flight ${index}` }, makeIdentity(fixture), {
          budgetConfig: config,
          budgetLedger: gatedLedger,
          modelCaller,
        });
      })(),
    ),
  );
  const successes = results.filter((result) => result.status === "fulfilled");
  const quotaRejects = results.filter(
    (result) =>
      result.status === "rejected" &&
      result.reason instanceof ApplicationError &&
      result.reason.code === "AI_QUOTA",
  );
  const counters = await readCounters(pool, fixture.tenantId);
  console.log(
    `T6/E6 metrics: gatewayCalls=${gatewayCalls} peakActiveCalls=${peakActiveCalls} ` +
      `sucessos=${successes.length} rejeições=${quotaRejects.length} ` +
      `tokens_reserved=${counters.tokens_reserved} in_flight=${counters.in_flight}`,
  );
  assert.equal(
    reserveAttempts,
    requestCount,
    "E6: as oito tentativas de reserveAtomic devem ocorrer",
  );
  assert.equal(
    completedReserveAttempts,
    requestCount,
    "E6: as oito tentativas de reserveAtomic devem concluir",
  );
  assert.equal(gatewayCalls, 2, "E6: exatamente os dois slots devem ser admitidos");
  assert.equal(peakActiveCalls <= 2, true, "E6: no máximo dois modelos simultâneos");
  assert.equal(successes.length, gatewayCalls, "E6: cada gateway call corresponde a um sucesso");
  assert.equal(
    quotaRejects.length,
    requestCount - gatewayCalls,
    "E6: excesso rejeitado como AI_QUOTA",
  );
  assert.equal(
    gatewayCalls <= 2,
    true,
    "E6: a barreira deve rejeitar o burst enquanto os slots estão ocupados",
  );
  assert.equal(counters.model_call_count, gatewayCalls);
  assert.equal(counters.tokens_reserved, 0);
  assert.equal(counters.in_flight, 0);
  console.log("T6/E6: limite in-flight sob concorrência: OK");
}

async function runE7(pool: Pool): Promise<void> {
  const fixture = await createFixture(pool, "e7");
  const result = await executeSendChatMessage({ message: "e7 regression" }, makeIdentity(fixture), {
    budgetConfig: testConfig(),
    modelCaller: async () => modelResponse("e7 response"),
  });
  assert.equal(result.content, "e7 response");
  const counters = await readCounters(pool, fixture.tenantId);
  assert.equal(counters.chat_count, 1);
  assert.equal(counters.model_call_count, 1);
  assert.equal(counters.input_tokens, 2);
  assert.equal(counters.output_tokens, 3);
  assert.equal(counters.tokens_reserved, 0);
  assert.equal(counters.in_flight, 0);
  console.log("T7/E7: single-shot preservado com contadores coerentes: OK");
}

async function runE8(pool: Pool): Promise<void> {
  const fixture = await createFixture(pool, "e8");
  const base = new Date();
  base.setUTCHours(12, 0, 0, 0);
  let clockNow = base;
  const config = testConfig({ dailyModelCallLimit: 2, dailyTokenLimit: 150, inFlightLimit: 1 });
  const previousTtl = process.env.AI_BUDGET_RESERVATION_TTL_MS;
  process.env.AI_BUDGET_RESERVATION_TTL_MS = "1000";
  try {
    assert.equal(
      budgetConfigFromEnv().reservationTtlMs,
      MIN_SAFE_RESERVATION_TTL_MS,
      "E8: TTL ambiental abaixo do limite seguro deve voltar ao default seguro",
    );
  } finally {
    if (previousTtl === undefined) delete process.env.AI_BUDGET_RESERVATION_TTL_MS;
    else process.env.AI_BUDGET_RESERVATION_TTL_MS = previousTtl;
  }
  assert.throws(
    () =>
      createBudgetLedger({
        identity: makeIdentity(fixture),
        config: { reservationTtlMs: 1_000 },
      }),
    /pelo menos 120000 ms/,
    "E8: override de TTL inseguro deve ser rejeitado",
  );
  const ledger = createBudgetLedger({
    identity: makeIdentity(fixture),
    config,
    clock: { now: () => clockNow },
  });
  const orphan = await ledger.reserveAtomic(fixture.tenantId, 100, {
    kind: "model",
    roundNo: 0,
    now: base,
  });
  assert.equal(orphan.status, "reserved");
  clockNow = new Date(base.getTime() + MIN_SAFE_RESERVATION_TTL_MS + 1_000);
  const fresh = await ledger.reserveAtomic(fixture.tenantId, 100, {
    kind: "model",
    roundNo: 1,
    now: clockNow,
  });
  assert.equal(fresh.status, "reserved", "E8: a nova reserva deve usar os contadores corrigidos");
  const countersWithFreshReservation = await readCounters(pool, fixture.tenantId, utcDay(base));
  assert.equal(countersWithFreshReservation.tokens_reserved, 100);
  assert.equal(countersWithFreshReservation.in_flight, 1);
  if (fresh.status === "reserved") {
    await ledger.settle(fresh.usageId, 0, "success", { now: new Date(clockNow.getTime() + 1) });
  }
  const counters = await readCounters(pool, fixture.tenantId, utcDay(base));
  assert.equal(counters.tokens_reserved, 0);
  assert.equal(counters.in_flight, 0);
  const usage = await readUsage(pool, fixture.tenantId);
  assert.deepEqual(
    usage.map(({ status }) => status),
    ["expired", "settled"],
  );
  console.log("T8/E8: TTL lazy sweep recupera reserva órfã antes da nova reserva: OK");
}

async function runE9(pool: Pool): Promise<void> {
  const fixture = await createFixture(pool, "e9");
  const base = new Date();
  base.setUTCHours(12, 0, 0, 0);
  const ledger = createBudgetLedger({
    identity: makeIdentity(fixture),
    config: testConfig({ inFlightLimit: 1 }),
  });
  const orphan = await ledger.reserveAtomic(fixture.tenantId, 100, {
    kind: "model",
    roundNo: 0,
    now: base,
  });
  assert.equal(orphan.status, "reserved");
  const firstSweep = await ledger.sweepOrphans(fixture.tenantId, {
    now: new Date(base.getTime() + MIN_SAFE_RESERVATION_TTL_MS + 1_000),
  });
  const secondSweep = await ledger.sweepOrphans(fixture.tenantId, {
    now: new Date(base.getTime() + MIN_SAFE_RESERVATION_TTL_MS + 2_000),
  });
  assert.deepEqual(firstSweep.expiredCount, 1);
  assert.deepEqual(secondSweep, { expiredCount: 0, usageIds: [] });
  const counters = await readCounters(pool, fixture.tenantId, utcDay(base));
  assert.equal(counters.tokens_reserved, 0);
  assert.equal(counters.in_flight, 0);
  assert.equal((await readUsage(pool, fixture.tenantId))[0]?.status, "expired");
  console.log("T9/E9: replay do sweep não duplica a correção: OK");
}

interface MemoryUsage {
  tenantId: string;
  budgetTokens: number;
  reservedAt: Date;
  status: "reserved" | "settled" | "expired";
}

function createMemoryContractLedger(
  config: BudgetLedgerConfig,
): Pick<BudgetLedger, "reserveAtomic" | "settle" | "sweepOrphans"> {
  const usages = new Map<string, MemoryUsage>();
  const counters = new Map<
    string,
    { modelCalls: number; tokensReserved: number; inFlight: number }
  >();

  function counter(tenantId: string) {
    const current = counters.get(tenantId) ?? { modelCalls: 0, tokensReserved: 0, inFlight: 0 };
    counters.set(tenantId, current);
    return current;
  }

  function sweep(tenantId: string, now: Date): SweepResult {
    const current = counter(tenantId);
    const cutoff = now.getTime() - config.reservationTtlMs;
    const usageIds: string[] = [];
    for (const [usageId, usage] of usages) {
      if (
        usage.tenantId === tenantId &&
        usage.status === "reserved" &&
        usage.reservedAt.getTime() < cutoff
      ) {
        usage.status = "expired";
        current.tokensReserved -= usage.budgetTokens;
        current.inFlight -= 1;
        usageIds.push(usageId);
      }
    }
    return { expiredCount: usageIds.length, usageIds };
  }

  return {
    async reserveAtomic(tenantId, budgetTokens, options): Promise<ReserveResult> {
      const now = options.now ?? new Date();
      sweep(tenantId, now);
      const current = counter(tenantId);
      if (
        current.modelCalls + 1 > config.dailyModelCallLimit ||
        current.tokensReserved + budgetTokens > config.dailyTokenLimit ||
        current.inFlight + 1 > config.inFlightLimit
      ) {
        return { status: "quota_reject", reason: "budget_limit" };
      }
      const usageId = randomUUID();
      current.modelCalls += 1;
      current.tokensReserved += budgetTokens;
      current.inFlight += 1;
      usages.set(usageId, {
        tenantId,
        budgetTokens,
        reservedAt: now,
        status: "reserved",
      });
      return { status: "reserved", usageId, budgetTokens, reservedAt: now };
    },
    async settle(usageId, _realTokens, _outcome, options = {}): Promise<SettlementResult> {
      const usage = usages.get(usageId);
      const now = options.now ?? new Date();
      if (usage?.status === "reserved") {
        usage.status = "settled";
        const current = counter(usage.tenantId);
        current.tokensReserved -= usage.budgetTokens;
        current.inFlight -= 1;
        const durationMs = Math.max(0, now.getTime() - usage.reservedAt.getTime());
        return { applied: true, usageId, budgetTokens: usage.budgetTokens, durationMs };
      }
      return { applied: false, usageId, budgetTokens: null, durationMs: null };
    },
    async sweepOrphans(tenantId, options = {}): Promise<SweepResult> {
      return sweep(tenantId, options.now ?? new Date());
    },
  };
}

async function runLedgerContract(
  label: string,
  ledger: Pick<BudgetLedger, "reserveAtomic" | "settle" | "sweepOrphans">,
  tenantId: string,
): Promise<void> {
  const base = new Date();
  base.setUTCHours(12, 0, 0, 0);
  const first = await ledger.reserveAtomic(tenantId, 100, { kind: "model", roundNo: 0, now: base });
  assert.equal(first.status, "reserved", `${label}: reserva deve ser aceita`);
  if (first.status !== "reserved") return;
  const blocked = await ledger.reserveAtomic(tenantId, 100, {
    kind: "model",
    roundNo: 1,
    now: new Date(base.getTime() + 1),
  });
  assert.deepEqual(
    blocked,
    { status: "quota_reject", reason: "budget_limit" },
    `${label}: quota reject`,
  );
  assert.equal(
    (
      await ledger.settle(first.usageId, 7, "success", {
        now: new Date(base.getTime() + 10),
        inputTokens: 3,
        outputTokens: 4,
      })
    ).applied,
    true,
  );
  assert.equal(
    (
      await ledger.settle(first.usageId, 7, "success", {
        now: new Date(base.getTime() + 20),
        inputTokens: 3,
        outputTokens: 4,
      })
    ).applied,
    false,
    `${label}: settlement replay`,
  );
  const orphan = await ledger.reserveAtomic(tenantId, 100, {
    kind: "model",
    roundNo: 2,
    now: base,
  });
  assert.equal(orphan.status, "reserved", `${label}: segunda reserva`);
  assert.equal(
    (
      await ledger.sweepOrphans(tenantId, {
        now: new Date(base.getTime() + MIN_SAFE_RESERVATION_TTL_MS + 1_000),
      })
    ).expiredCount,
    1,
    `${label}: sweep TTL`,
  );
  assert.equal(
    (
      await ledger.sweepOrphans(tenantId, {
        now: new Date(base.getTime() + MIN_SAFE_RESERVATION_TTL_MS + 2_000),
      })
    ).expiredCount,
    0,
    `${label}: sweep idempotente`,
  );
}

async function runE10(pool: Pool): Promise<void> {
  const config = testConfig({ dailyModelCallLimit: 2, dailyTokenLimit: 200, inFlightLimit: 1 });
  const fixture = await createFixture(pool, "e10");
  const actual = createBudgetLedger({ identity: makeIdentity(fixture), config });
  await runLedgerContract("node-postgres", actual, fixture.tenantId);
  await runLedgerContract(
    "neon-serverless-contract-adapter",
    createMemoryContractLedger(config),
    "contract-tenant",
  );
  console.log("T10/E10: contrato comum node-postgres + adaptador sem endpoint Neon: OK");
}

async function main(): Promise<void> {
  process.env.AI_CHAT_LIMIT_PER_10_MINUTES = "1000";
  const pool = new Pool({ connectionString: requireAdminUrl(), max: 30 });
  const database = drizzle({ client: pool, schema });
  setDatabaseForTests(database as unknown as Database);
  try {
    if (process.env.E6_ONLY === "1") {
      await runE6(pool);
    } else {
      await runE1(pool);
      await runE2(pool);
      await runE3(pool);
      await runE4(pool);
      await runE5(pool);
      await runE6(pool);
      await runE7(pool);
      await runE8(pool);
      await runE9(pool);
      await runE10(pool);
    }
  } finally {
    const tenantIds = createdFixtures.map((fixture) => fixture.tenantId);
    const userIds = createdFixtures.map((fixture) => fixture.userId);
    if (tenantIds.length > 0) {
      for (const table of MEMORY_TRAIL_TABLES) {
        // pi-lens-ignore: no-sql-in-code
        await pool.query(`delete from ${table} where tenant_id = any($1::uuid[])`, [tenantIds]);
      }
      await pool.query("delete from tenants where id = any($1::uuid[])", [tenantIds]);
      await pool.query("delete from users where id = any($1::text[])", [userIds]);
    }
    setDatabaseForTests(undefined);
    await pool.end();
  }
  console.log(
    process.env.E6_ONLY === "1"
      ? "E6_ONLY: cenário E6 concluído"
      : "T1–T10: suíte local de orçamento concluída",
  );
}

await main();
