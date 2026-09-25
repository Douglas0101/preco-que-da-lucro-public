import Decimal from "decimal.js";
import { sql, type SQL } from "drizzle-orm";
import { z } from "zod";
// This module executes database transactions and must remain server-only.
import {
  transactionManager as defaultTransactionManager,
  type DatabaseIdentity,
  type DatabaseTransaction,
  type TransactionManager,
} from "@/db/client.server";
import { toDecimalString } from "@/lib/financial-values";
import { applicationMetrics } from "@/instrumentation/telemetry";
import { logJson } from "@/lib/structured-logger";
import { type TokenUsage, type TokenUsageUnknownReason } from "@/lib/ai/token-usage";

export const DEFAULT_BUDGET_CONFIG = {
  dailyModelCallLimit: 500,
  dailyTokenLimit: 1_500_000,
  dailyChatLimit: 200,
  inFlightLimit: 2,
  conservativeTokenBudget: 64_000,
  reservationTtlMs: 120_000,
} as const;

// The chat request timeout is capped at 60 seconds in chat-execution.server.ts.
// Keep one full request-timeout window as margin so lazy sweeping cannot reclaim
// a reservation while its production gateway call is still alive.
export const MIN_SAFE_RESERVATION_TTL_MS = 120_000;

export interface BudgetLedgerConfig {
  dailyModelCallLimit: number;
  dailyTokenLimit: number;
  dailyChatLimit: number;
  inFlightLimit: number;
  conservativeTokenBudget: number;
  reservationTtlMs: number;
}

export interface BudgetClock {
  now(): Date;
}

export interface ReserveOptions {
  kind: string;
  roundNo: number;
  now?: Date;
}

// Reserved for R3 (per-tool cost attribution): ai_usage.tool_execution_id
// (nullable, migration 0009) exists in the schema, but reserve/settle below
// intentionally never write it — the column stays NULL until the orchestrator
// owns per-tool attribution. See docs/evidence/s4-ai-pricing-hardening-2026-09-01.md.
export interface SettleOptions {
  now?: Date;
  inputTokens?: number;
  outputTokens?: number;
  toolCalls?: number;
  /** Cost string (4 decimals) when `costStatus` is "known"; null otherwise. Never invent "missing" as zero. */
  estimatedCost?: string | null;
  /** Defaults to "unknown" so pricing-less callers never write a fabricated known cost. */
  costStatus?: "known" | "unknown" | "invalid";
}

/**
 * What a settlement is allowed to assert about token usage (INV-006).
 *
 * A plain `number` keeps every pre-existing call site working unchanged. A
 * `TokenUsage` carries the gateway classification: only `{ kind: "known" }`
 * produces counts; `{ kind: "unknown" }` is persisted as such instead of being
 * coerced into a zero that was never measured.
 */
export type SettlementUsage = number | TokenUsage;

export interface ModelTokenPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface EstimatedCostResult {
  cost: string | null;
  status: "known" | "unknown" | "invalid";
}

export interface SweepOptions {
  now?: Date;
}

export interface ReservedUsage {
  status: "reserved";
  usageId: string;
  budgetTokens: number;
  reservedAt: Date;
}

export interface QuotaReject {
  status: "quota_reject";
  reason: "budget_limit";
}

export type ReserveResult = ReservedUsage | QuotaReject;

export interface SettlementResult {
  applied: boolean;
  usageId: string;
  budgetTokens: number | null;
  durationMs: number | null;
}

export interface SweepResult {
  expiredCount: number;
  usageIds: readonly string[];
}

/**
 * TRILHO B — reconciliação dos eventos `usage_unknown`.
 *
 * O varredor de reservas só alcança `status='reserved'`; um evento que chegou a
 * `settle` sem medição fica em `status='settled'` + `outcome='usage_unknown'` e
 * nunca é revisitado, retendo `tokens_reserved` indefinidamente. Este caminho
 * fecha essa lacuna **sem liberar a reserva**: ele torna o estado persistido e
 * auditável, e a liberação continua sendo uma decisão humana em comando próprio.
 */
export interface ReconcileUnknownOptions {
  /** Idade mínima desde `settled_at` para tratar a linha (ms). */
  minAgeMs?: number;
  /** Teto de linhas tratadas em uma execução. */
  batchSize?: number;
  now?: Date;
}

export interface ReconcileUnknownResult {
  /** Linhas candidatas dentro do corte de idade. */
  scannedCount: number;
  /** Linhas efetivamente marcadas nesta execução (CAS ganho). */
  failedCount: number;
  /** `usage_id`s marcados **nesta** execução — vazio em replay. */
  usageIds: readonly string[];
  /** Idade do candidato mais antigo visto, ou `null` quando não houve candidato. */
  oldestAgeMs: number | null;
}

/** Rótulo persistido em `ai_usage.outcome` quando não há como medir o uso real. */
export const RECONCILIATION_FAILED_OUTCOME = "reconciliation_failed";

/**
 * Rótulo gravado pelo **comando humano** de liberação. Deliberadamente **não** é
 * `reconciled`: nada foi reconciliado — a medição continua impossível e
 * `real_tokens` continua `NULL`. O rótulo diz o que de fato aconteceu: a reserva
 * foi devolvida sem que o consumo tenha sido medido.
 */
export const RESERVATION_RELEASED_OUTCOME = "reservation_released";

export interface ReleaseUnknownResult {
  /** `false` quando o CAS não encontrou a linha (replay, ou outro executor venceu). */
  applied: boolean;
  usageId: string;
  /** Tokens devolvidos a `tokens_reserved`, ou `null` quando `applied` é `false`. */
  releasedTokens: number | null;
}

export const DEFAULT_RECONCILE_MIN_AGE_MS = 6 * 60 * 60 * 1000;
export const DEFAULT_RECONCILE_BATCH_SIZE = 100;
export const MAX_RECONCILE_BATCH_SIZE = 1_000;

export interface BudgetLedger {
  reserveChatInTransaction(
    transaction: DatabaseTransaction,
    tenantId: string,
    options?: { now?: Date },
  ): Promise<boolean>;
  reserveAtomic(
    tenantId: string,
    budgetTokens: number,
    options: ReserveOptions,
  ): Promise<ReserveResult>;
  settle(
    usageId: string,
    usage: SettlementUsage,
    outcome: string,
    options?: SettleOptions,
  ): Promise<SettlementResult>;
  sweepOrphans(tenantId: string, options?: SweepOptions): Promise<SweepResult>;
  reconcileUnknownUsage(
    tenantId: string,
    options?: ReconcileUnknownOptions,
  ): Promise<ReconcileUnknownResult>;
  /**
   * Devolve a reserva retida de **um** evento `reconciliation_failed`. É o passo
   * que a decisão humana reservou para comando explícito: nunca é chamado pelo
   * job de reconciliação. `real_tokens` permanece `NULL`.
   */
  releaseUnknownReservation(
    tenantId: string,
    usageId: string,
    options?: { now?: Date },
  ): Promise<ReleaseUnknownResult>;
}

export interface BudgetLedgerDependencies {
  identity: DatabaseIdentity;
  transactionManager?: TransactionManager;
  config?: Partial<BudgetLedgerConfig>;
  clock?: BudgetClock;
}

interface ExpiredRow {
  usageId: string;
  budgetTokens: number;
  reservedAt: Date | string;
}

interface ClaimedRow {
  budgetTokens: number;
  reservedAt: Date | string;
}

interface ReservationRow {
  usageId: string;
  reservedAt: Date | string;
}

interface SweepInTransactionResult extends SweepResult {
  expired: readonly ExpiredRow[];
}

function rows<T>(result: unknown): T[] {
  const value = result as { rows?: unknown[] };
  return (value.rows ?? []) as T[];
}

function integerSetting(name: string, fallback: number, min: number, max: number): number {
  const parsed = Number(process.env[name]);
  return Number.isInteger(parsed) && parsed >= min && parsed <= max ? parsed : fallback;
}

export function budgetConfigFromEnv(): BudgetLedgerConfig {
  return {
    dailyModelCallLimit: integerSetting(
      "AI_DAILY_MODEL_CALL_LIMIT_PER_TENANT",
      DEFAULT_BUDGET_CONFIG.dailyModelCallLimit,
      1,
      100_000,
    ),
    dailyTokenLimit: integerSetting(
      "AI_DAILY_TOKEN_LIMIT_PER_TENANT",
      DEFAULT_BUDGET_CONFIG.dailyTokenLimit,
      1,
      100_000_000,
    ),
    dailyChatLimit: integerSetting(
      "AI_DAILY_CHAT_LIMIT_PER_TENANT",
      DEFAULT_BUDGET_CONFIG.dailyChatLimit,
      1,
      100_000,
    ),
    inFlightLimit: integerSetting(
      "AI_IN_FLIGHT_LIMIT_PER_TENANT",
      DEFAULT_BUDGET_CONFIG.inFlightLimit,
      1,
      1_000,
    ),
    conservativeTokenBudget: integerSetting(
      "AI_CONSERVATIVE_TOKEN_BUDGET",
      DEFAULT_BUDGET_CONFIG.conservativeTokenBudget,
      1,
      1_000_000,
    ),
    reservationTtlMs: integerSetting(
      "AI_BUDGET_RESERVATION_TTL_MS",
      DEFAULT_BUDGET_CONFIG.reservationTtlMs,
      MIN_SAFE_RESERVATION_TTL_MS,
      3_600_000,
    ),
  };
}

function resolveConfig(overrides: Partial<BudgetLedgerConfig> | undefined): BudgetLedgerConfig {
  return { ...budgetConfigFromEnv(), ...overrides };
}

// Conservative placeholder prices (USD per million tokens) so cost estimation
// can run out of the box. They are NOT vendor quotes: override them for the
// production gateway via AI_MODEL_PRICING_JSON before relying on the totals.
const DEFAULT_MODEL_TOKEN_PRICES: Record<string, ModelTokenPrice> = Object.freeze({
  "google/gemini-3.6-flash": { inputPerMillion: 0.1, outputPerMillion: 0.4 },
});

// API-001 §6.9 + INV-014: AI_MODEL_PRICING_JSON is untrusted config and is
// validated at boot. Zero prices are accepted deliberately (a model configured
// as free must estimate "0.0000" as "known", never fall into "unknown");
// negative, non-finite, missing or non-numeric fields are rejected explicitly.
const ModelPriceSchema = z.object({
  inputPerMillion: z.number().finite().nonnegative(),
  outputPerMillion: z.number().finite().nonnegative(),
});

const ModelPricingSchema = z.record(z.string().min(1).max(200), ModelPriceSchema);

const PRICING_EXPECTED_SHAPE =
  'esperado {"<modelo>":{"inputPerMillion":<número finito ≥ 0>,"outputPerMillion":<número finito ≥ 0>}}';

function pricingConfigError(detail: string, cause?: unknown): Error {
  // §19.4: the message must never echo the raw env value or the parsed prices.
  return new Error(`CONFIG_ERROR: AI_MODEL_PRICING_JSON inválida — ${detail}`, { cause });
}

/**
 * Reads AI_MODEL_PRICING_JSON (model -> {inputPerMillion, outputPerMillion}).
 * Absent/empty variable → documented conservative defaults (config absent ≠
 * config invalid). Set but malformed → explicit `CONFIG_ERROR` throw
 * (API-001 §6.9, fail-fast; never a silent fallback once the variable exists).
 */
export function modelTokenPricesFromEnv(
  env: Record<string, string | undefined> = process.env,
): Record<string, ModelTokenPrice> {
  const raw = env.AI_MODEL_PRICING_JSON;
  if (!raw) return { ...DEFAULT_MODEL_TOKEN_PRICES };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw pricingConfigError(
      "não é JSON válido. Corrija a variável ou remova-a para usar os preços padrão documentados.",
      cause,
    );
  }
  const result = ModelPricingSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .slice(0, 5)
      .map((issue) => `${issue.path.join(".") || "<raiz>"}: ${issue.message}`)
      .join("; ");
    throw pricingConfigError(`formato inesperado (${issues}). ${PRICING_EXPECTED_SHAPE}`);
  }
  return result.data;
}

/**
 * Boot-time fail-fast guard (API-001 §6.9 / §14.6): the server entry calls this
 * once at startup. An invalid AI_MODEL_PRICING_JSON must prevent boot with an
 * explicit CONFIG_ERROR; an absent variable keeps the documented defaults so
 * development boots without configuration. Never logs prices (§19.4).
 */
export function assertPricingConfigForBoot(
  env: Record<string, string | undefined> = process.env,
): Record<string, ModelTokenPrice> {
  return modelTokenPricesFromEnv(env);
}

function isCountableToken(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

/**
 * Estimates the USD cost of a model round. Returns "known" only when the model
 * has a configured price (INV-006: unknown/absent pricing is never fabricated
 * as a zero cost); non-finite or negative token counts are "invalid".
 */
export function estimateModelCost(
  modelName: string | null,
  inputTokens: number,
  outputTokens: number,
  prices: Record<string, ModelTokenPrice> = modelTokenPricesFromEnv(),
): EstimatedCostResult {
  if (!isCountableToken(inputTokens) || !isCountableToken(outputTokens)) {
    return { cost: null, status: "invalid" };
  }
  const price = modelName ? prices[modelName] : undefined;
  if (!price) return { cost: null, status: "unknown" };
  const cost = new Decimal(inputTokens)
    .mul(price.inputPerMillion)
    .add(new Decimal(outputTokens).mul(price.outputPerMillion))
    .div(1_000_000);
  if (!cost.isFinite() || cost.isNeg()) return { cost: null, status: "invalid" };
  try {
    return { cost: toDecimalString(cost, 4), status: "known" };
  } catch {
    return { cost: null, status: "invalid" };
  }
}

function assertNonNegativeInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value < 0) {
    throw new TypeError(`${name} deve ser um inteiro não negativo`);
  }
}

function assertPositiveInteger(name: string, value: number): void {
  if (!Number.isInteger(value) || value <= 0) {
    throw new TypeError(`${name} deve ser um inteiro positivo`);
  }
}

function assertSafeReservationTtl(value: number): void {
  if (!Number.isInteger(value) || value < MIN_SAFE_RESERVATION_TTL_MS) {
    throw new TypeError(
      `reservationTtlMs deve ser um inteiro de pelo menos ${MIN_SAFE_RESERVATION_TTL_MS} ms`,
    );
  }
}

function assertDate(value: Date, name: string): void {
  if (Number.isNaN(value.getTime())) throw new TypeError(`${name} deve ser uma data válida`);
}

function assertText(name: string, value: string): void {
  const containsControlCharacter = Array.from(value).some((character) => {
    const codePoint = character.codePointAt(0) ?? 0;
    return codePoint <= 0x1f || codePoint === 0x7f;
  });
  if (!value || value.length > 128 || containsControlCharacter) {
    throw new TypeError(`${name} inválido`);
  }
}

function utcDate(value: Date | string): string {
  const date = value instanceof Date ? value : new Date(value);
  assertDate(date, "reservedAt");
  return date.toISOString().slice(0, 10);
}

function asInteger(value: unknown, name: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  assertNonNegativeInteger(name, parsed);
  return parsed;
}

function durationMs(now: Date, startedAt: Date | string): number {
  const elapsed = now.getTime() - new Date(startedAt).getTime();
  return Number.isFinite(elapsed) ? Math.max(0, elapsed) : 0;
}

function assertIdentityTenant(identity: DatabaseIdentity, tenantId: string): void {
  if (identity.tenantId !== tenantId) {
    throw new Error("O tenant da operação de orçamento não corresponde à identidade autenticada");
  }
}

function tokenBreakdown(
  realTokens: number,
  options: SettleOptions,
): { inputTokens: number; outputTokens: number } {
  assertNonNegativeInteger("realTokens", realTokens);
  const inputTokens = options.inputTokens ?? 0;
  const outputTokens = options.outputTokens ?? Math.max(0, realTokens - inputTokens);
  assertNonNegativeInteger("inputTokens", inputTokens);
  assertNonNegativeInteger("outputTokens", outputTokens);
  if (inputTokens + outputTokens !== realTokens) {
    throw new RangeError("inputTokens + outputTokens deve corresponder a realTokens");
  }
  return { inputTokens, outputTokens };
}

type ResolvedSettlement =
  | {
      kind: "known";
      realTokens: number;
      breakdown: { inputTokens: number; outputTokens: number };
    }
  | { kind: "unknown"; reason: TokenUsageUnknownReason };

/**
 * Normalises a settlement input into counts we can defend (INV-006).
 *
 * A numeric input is treated as an already-known measurement (legacy call sites).
 * A `TokenUsage` is honoured as classified: `unknown` never fabricates a breakdown.
 */
function resolveSettlementUsage(
  usage: SettlementUsage,
  options: SettleOptions,
): ResolvedSettlement {
  if (typeof usage === "number") {
    return { kind: "known", realTokens: usage, breakdown: tokenBreakdown(usage, options) };
  }
  if (usage.kind === "unknown") return { kind: "unknown", reason: usage.reason };

  const realTokens = usage.inputTokens + usage.outputTokens;
  return {
    kind: "known",
    realTokens,
    breakdown: tokenBreakdown(realTokens, {
      ...options,
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
    }),
  };
}

interface BudgetCostSetters {
  /** Known decimal string to add to ai_daily_budgets.estimated_cost, or null. */
  costIncrement: string | null;
  /** Unknown-usable rounds also burden the daily unknown counter. */
  unknownIncrement: boolean;
}

function resolveBudgetCostSetters(options: SettleOptions): BudgetCostSetters {
  const status =
    options.costStatus === "known" || options.costStatus === "invalid"
      ? options.costStatus
      : "unknown";
  const value = options.estimatedCost ?? null;
  if (status === "known") {
    // Only a parseable, non-negative decimal may enter the summed column. A
    // "known" status without a resolvable string is treated as unknowable
    // rather than corrupting the daily estimated total with an invented zero.
    let parsed: Decimal | null = null;
    if (value !== null) {
      try {
        const candidate = new Decimal(value);
        if (candidate.isFinite() && !candidate.isNeg()) parsed = candidate;
      } catch {
        parsed = null;
      }
    }
    if (parsed !== null) return { costIncrement: parsed.toFixed(4), unknownIncrement: false };
    return { costIncrement: null, unknownIncrement: true };
  }
  // "unknown" and "invalid" both leave the known total untouched; either way
  // the round is accounted in the unknown-usable counter.
  return { costIncrement: null, unknownIncrement: true };
}

/**
 * Intentional deviation: tool_executions cost fields are intentionally NOT
 * written. Cost is tracked per model round via ai_usage; tool executions share
 * the round's gateway spend, so per-tool costs would double-count it.
 */
function budgetCostSetterSql(options: SettleOptions): SQL {
  const { costIncrement, unknownIncrement } = resolveBudgetCostSetters(options);
  const parts: SQL[] = [];
  if (costIncrement !== null) {
    parts.push(sql`estimated_cost = estimated_cost + ${costIncrement}`);
  }
  if (unknownIncrement) {
    parts.push(sql`estimated_cost_unknown_count = estimated_cost_unknown_count + 1`);
  }
  return sql.join(parts, sql`, `);
}

async function sweepOrphansInTransaction(
  transaction: DatabaseTransaction,
  tenantId: string,
  now: Date,
  config: BudgetLedgerConfig,
): Promise<SweepInTransactionResult> {
  const cutoff = new Date(now.getTime() - config.reservationTtlMs);
  const expiredResult = await transaction.execute(sql`
    update ai_usage
    set
      status = 'expired',
      settled_at = ${now},
      real_tokens = 0,
      outcome = 'ttl_expired'
    where tenant_id = ${tenantId}
      and status = 'reserved'
      and reserved_at < ${cutoff}
    returning usage_id::text as "usageId", budget_tokens as "budgetTokens", reserved_at as "reservedAt"
  `);
  const expired = rows<ExpiredRow>(expiredResult).map((row) => ({
    usageId: String(row.usageId),
    budgetTokens: asInteger(row.budgetTokens, "budgetTokens"),
    reservedAt: row.reservedAt as Date | string,
  }));
  if (expired.length === 0) return { expiredCount: 0, usageIds: [], expired };

  const grouped = new Map<string, { budgetTokens: number; count: number }>();
  for (const row of expired) {
    const date = utcDate(row.reservedAt);
    const current = grouped.get(date) ?? { budgetTokens: 0, count: 0 };
    current.budgetTokens += row.budgetTokens;
    current.count += 1;
    grouped.set(date, current);
  }

  for (const [usageDate, group] of grouped) {
    const countersResult = await transaction.execute(sql`
      update ai_daily_budgets
      set
        tokens_reserved = tokens_reserved - ${group.budgetTokens},
        in_flight = in_flight - ${group.count},
        updated_at = ${now}
      where tenant_id = ${tenantId}
        and usage_date = ${usageDate}
      returning tokens_reserved as "tokensReserved", in_flight as "inFlight"
    `);
    if (rows(countersResult).length !== 1) {
      throw new Error("Não foi possível reconciliar o contador do orçamento expirado");
    }
  }

  return {
    expiredCount: expired.length,
    usageIds: expired.map((row) => row.usageId),
    expired,
  };
}

function logExpired(tenantId: string, now: Date, result: SweepInTransactionResult): void {
  for (const row of result.expired) {
    logJson("info", "ai.budget_expired", {
      tenantId,
      usageId: row.usageId,
      budget: row.budgetTokens,
      real: 0,
      durationMs: durationMs(now, row.reservedAt),
      outcome: "ttl_expired",
    });
  }
}

interface UnknownUsageRow {
  usageId: string;
  budgetTokens: number;
  settledAt: Date | string;
}

interface ReconcileInTransactionResult {
  scannedCount: number;
  oldestAgeMs: number | null;
  failed: readonly UnknownUsageRow[];
}

async function reconcileUnknownInTransaction(
  transaction: DatabaseTransaction,
  tenantId: string,
  now: Date,
  minAgeMs: number,
  batchSize: number,
): Promise<ReconcileInTransactionResult> {
  const cutoff = new Date(now.getTime() - minAgeMs);
  const candidateResult = await transaction.execute(sql`
    select
      usage_id::text as "usageId",
      budget_tokens as "budgetTokens",
      settled_at as "settledAt"
    from ai_usage
    where tenant_id = ${tenantId}
      and status = 'settled'
      and outcome = 'usage_unknown'
      and settled_at is not null
      and settled_at < ${cutoff}
    order by settled_at asc
    limit ${batchSize}
  `);
  const candidates = rows<UnknownUsageRow>(candidateResult).map((row) => ({
    usageId: String(row.usageId),
    budgetTokens: asInteger(row.budgetTokens, "budgetTokens"),
    settledAt: row.settledAt as Date | string,
  }));
  if (candidates.length === 0) return { scannedCount: 0, oldestAgeMs: null, failed: [] };

  let oldestAgeMs = 0;
  const failed: UnknownUsageRow[] = [];
  for (const candidate of candidates) {
    const age = durationMs(now, candidate.settledAt);
    if (age > oldestAgeMs) oldestAgeMs = age;
    // INV-009 — compare-and-set pela identidade do evento. `returning` vazio
    // significa que outro executor (ou o comando humano de liberação) já tratou
    // esta linha: o replay é no-op e nunca duplica efeito. O `status` continua
    // `settled` e `real_tokens` continua nulo — nada aqui inventa um número.
    const claimedResult = await transaction.execute(sql`
      update ai_usage
      set outcome = ${RECONCILIATION_FAILED_OUTCOME}
      where usage_id = ${candidate.usageId}
        and tenant_id = ${tenantId}
        and status = 'settled'
        and outcome = 'usage_unknown'
      returning usage_id::text as "usageId"
    `);
    if (rows(claimedResult).length !== 1) continue;
    failed.push(candidate);
  }
  return { scannedCount: candidates.length, oldestAgeMs, failed };
}

async function releaseUnknownInTransaction(
  transaction: DatabaseTransaction,
  tenantId: string,
  usageId: string,
  now: Date,
): Promise<ReleaseUnknownResult> {
  // INV-009 — o CAS é o que torna o comando humano seguro de repetir: um replay
  // não encontra mais `reconciliation_failed` e devolve `applied: false` sem
  // tocar no contador.
  const claimedResult = await transaction.execute(sql`
    update ai_usage
    set outcome = ${RESERVATION_RELEASED_OUTCOME}
    where usage_id = ${usageId}
      and tenant_id = ${tenantId}
      and status = 'settled'
      and outcome = ${RECONCILIATION_FAILED_OUTCOME}
    returning budget_tokens as "budgetTokens", reserved_at as "reservedAt"
  `);
  const [claimed] = rows<ClaimedRow>(claimedResult);
  if (!claimed) return { applied: false, usageId, releasedTokens: null };

  const budgetTokens = asInteger(claimed.budgetTokens, "budgetTokens");
  const usageDate = utcDate(claimed.reservedAt);
  // Só `tokens_reserved` volta: `in_flight` já foi decrementado no `settle`, e
  // `real_tokens` continua `NULL` — devolver a reserva não mede o consumo.
  const countersResult = await transaction.execute(sql`
    update ai_daily_budgets
    set
      tokens_reserved = tokens_reserved - ${budgetTokens},
      updated_at = ${now}
    where tenant_id = ${tenantId}
      and usage_date = ${usageDate}
    returning tokens_reserved as "tokensReserved"
  `);
  if (rows(countersResult).length !== 1) {
    throw new Error("A liberação não encontrou o contador diário correspondente");
  }
  return { applied: true, usageId, releasedTokens: budgetTokens };
}

function logReconciliationFailed(
  tenantId: string,
  now: Date,
  result: ReconcileInTransactionResult,
): void {
  for (const row of result.failed) {
    applicationMetrics.aiReconciliationTotal.add(1, { outcome: RECONCILIATION_FAILED_OUTCOME });
    applicationMetrics.aiReconciliationFailed.add(1, { outcome: RECONCILIATION_FAILED_OUTCOME });
    logJson("warn", "ai.reconciliation_failed", {
      tenantId,
      usageId: row.usageId,
      budget: row.budgetTokens,
      real: null,
      durationMs: durationMs(now, row.settledAt),
      outcome: RECONCILIATION_FAILED_OUTCOME,
      reason: "gateway_retrieval_unavailable",
    });
  }
  // O gauge NÃO é publicado aqui de propósito. Esta função roda uma vez por
  // tenant (o CLI itera tenants) e o gauge é last-write-wins: cada escrita apaga
  // a anterior. Publicar por tenant fazia um tenant posterior SEM candidatos
  // gravar 0 e apagar a idade de backlog de um tenant anterior — defeito D10,
  // regressão introduzida pela correção do D2. Quem publica é o chamador, uma
  // única vez, com o MÁXIMO da corrida inteira. Os counters acima ficam: são
  // por evento e somam corretamente entre tenants.
}

export function createBudgetLedger(dependencies: BudgetLedgerDependencies): BudgetLedger {
  const transactionRunner = dependencies.transactionManager ?? defaultTransactionManager;
  const config = resolveConfig(dependencies.config);
  const clock = dependencies.clock ?? { now: () => new Date() };

  assertPositiveInteger("dailyModelCallLimit", config.dailyModelCallLimit);
  assertPositiveInteger("dailyTokenLimit", config.dailyTokenLimit);
  assertPositiveInteger("dailyChatLimit", config.dailyChatLimit);
  assertPositiveInteger("inFlightLimit", config.inFlightLimit);
  assertPositiveInteger("conservativeTokenBudget", config.conservativeTokenBudget);
  assertSafeReservationTtl(config.reservationTtlMs);

  return {
    async reserveChatInTransaction(transaction, tenantId, options = {}): Promise<boolean> {
      assertIdentityTenant(dependencies.identity, tenantId);
      const now = options.now ?? clock.now();
      assertDate(now, "now");
      const usageDate = utcDate(now);
      await transaction.execute(sql`
        insert into ai_daily_budgets (tenant_id, usage_date)
        values (${tenantId}, ${usageDate})
        on conflict (tenant_id, usage_date) do nothing
      `);
      const result = await transaction.execute(sql`
        update ai_daily_budgets
        set
          chat_count = chat_count + 1,
          updated_at = ${now}
        where tenant_id = ${tenantId}
          and usage_date = ${usageDate}
          and chat_count + 1 <= ${config.dailyChatLimit}
        returning chat_count as "chatCount"
      `);
      const accepted = rows(result).length === 1;
      if (!accepted) {
        logJson("warn", "ai.chat_budget_rejected", {
          tenantId,
          outcome: "chat_limit",
        });
      }
      return accepted;
    },

    async reserveAtomic(tenantId, budgetTokens, options): Promise<ReserveResult> {
      assertIdentityTenant(dependencies.identity, tenantId);
      assertPositiveInteger("budgetTokens", budgetTokens);
      assertText("kind", options.kind);
      assertNonNegativeInteger("roundNo", options.roundNo);
      const now = options.now ?? clock.now();
      assertDate(now, "now");
      const usageDate = utcDate(now);

      const transactionResult = await transactionRunner.run(
        dependencies.identity,
        async (
          transaction,
        ): Promise<{
          sweep: SweepInTransactionResult;
          reservation: ReservedUsage | null;
        }> => {
          const sweep = await sweepOrphansInTransaction(transaction, tenantId, now, config);
          await transaction.execute(sql`
            insert into ai_daily_budgets (tenant_id, usage_date)
            values (${tenantId}, ${usageDate})
            on conflict (tenant_id, usage_date) do nothing
          `);

          const countersResult = await transaction.execute(sql`
            update ai_daily_budgets
            set
              model_call_count = model_call_count + 1,
              tokens_reserved = tokens_reserved + ${budgetTokens},
              in_flight = in_flight + 1,
              updated_at = ${now}
            where tenant_id = ${tenantId}
              and usage_date = ${usageDate}
              and model_call_count + 1 <= ${config.dailyModelCallLimit}
              and input_tokens + output_tokens + tokens_reserved + ${budgetTokens} <= ${config.dailyTokenLimit}
              and in_flight + 1 <= ${config.inFlightLimit}
            returning model_call_count as "modelCallCount", tokens_reserved as "tokensReserved", in_flight as "inFlight"
          `);
          if (rows(countersResult).length !== 1) {
            return { sweep, reservation: null };
          }

          const usageResult = await transaction.execute(sql`
            insert into ai_usage (tenant_id, kind, round_no, budget_tokens, status, reserved_at)
            values (${tenantId}, ${options.kind}, ${options.roundNo}, ${budgetTokens}, 'reserved', ${now})
            returning usage_id::text as "usageId", reserved_at as "reservedAt"
          `);
          const [usage] = rows<ReservationRow>(usageResult);
          if (!usage) throw new Error("A reserva foi debitada sem trilha de uso");
          return {
            sweep,
            reservation: {
              status: "reserved",
              usageId: String(usage.usageId),
              budgetTokens,
              reservedAt: new Date(usage.reservedAt),
            },
          };
        },
      );
      logExpired(tenantId, now, transactionResult.sweep);

      if (!transactionResult.reservation) {
        logJson("warn", "ai.budget_rejected", {
          tenantId,
          budget: budgetTokens,
          kind: options.kind,
          roundNo: options.roundNo,
          outcome: "budget_limit",
        });
        return { status: "quota_reject", reason: "budget_limit" };
      }

      logJson("info", "ai.budget_reserved", {
        tenantId,
        usageId: transactionResult.reservation.usageId,
        budget: budgetTokens,
        real: 0,
        durationMs: 0,
        outcome: "reserved",
        kind: options.kind,
        roundNo: options.roundNo,
      });
      return transactionResult.reservation;
    },

    async settle(usageId, usage, outcome, options = {}): Promise<SettlementResult> {
      assertText("usageId", usageId);
      assertText("outcome", outcome);
      const now = options.now ?? clock.now();
      assertDate(now, "now");
      const settlement = resolveSettlementUsage(usage, options);
      const toolCalls = options.toolCalls ?? 0;
      assertNonNegativeInteger("toolCalls", toolCalls);
      // The column already carries reasons (`ttl_expired`, `chat_limit`, `budget_limit`),
      // so an unknown measurement is recorded as a reason rather than as a flow result.
      // The flow outcome travels in the structured event below, so nothing is lost.
      const persistedOutcome = settlement.kind === "unknown" ? "usage_unknown" : outcome;

      const applySettlement = () =>
        transactionRunner.run(
          dependencies.identity,
          async (transaction): Promise<SettlementResult> => {
            const claimedResult = await transaction.execute(sql`
              update ai_usage
              set
                status = 'settled',
                settled_at = ${now},
                real_tokens = ${settlement.kind === "known" ? settlement.realTokens : null},
                outcome = ${persistedOutcome},
                estimated_cost = ${options.estimatedCost ?? null},
                cost_status = ${options.costStatus ?? "unknown"}
              where usage_id = ${usageId}
                and tenant_id = ${dependencies.identity.tenantId}
                and status = 'reserved'
              returning budget_tokens as "budgetTokens", reserved_at as "reservedAt"
            `);
            const [claimed] = rows<ClaimedRow>(claimedResult);
            if (!claimed) return { applied: false, usageId, budgetTokens: null, durationMs: null };

            const budgetTokens = asInteger(claimed.budgetTokens, "budgetTokens");
            const usageDate = utcDate(claimed.reservedAt);
            // Known usage: release the reservation and add the measured counts.
            // Unknown usage (INV-006): the call is no longer in flight, but the reserved
            // tokens stay held — releasing them would assert a consumption of zero that
            // was never measured, which is exactly what hid usage from the daily ceiling.
            // Retaining the reservation errs on the safe side (over-estimate) and the
            // `ai.usage_unknown` event keeps the leak visible for reconciliation.
            const counterUpdates =
              settlement.kind === "known"
                ? [
                    sql`tokens_reserved = tokens_reserved - ${budgetTokens}`,
                    sql`in_flight = in_flight - 1`,
                    sql`input_tokens = input_tokens + ${settlement.breakdown.inputTokens}`,
                    sql`output_tokens = output_tokens + ${settlement.breakdown.outputTokens}`,
                    sql`tool_call_count = tool_call_count + ${toolCalls}`,
                    budgetCostSetterSql(options),
                    sql`updated_at = ${now}`,
                  ]
                : [
                    sql`in_flight = in_flight - 1`,
                    sql`tool_call_count = tool_call_count + ${toolCalls}`,
                    budgetCostSetterSql(options),
                    sql`updated_at = ${now}`,
                  ];
            const countersResult = await transaction.execute(sql`
              update ai_daily_budgets
              set ${sql.join(counterUpdates, sql`, `)}
              where tenant_id = ${dependencies.identity.tenantId}
                and usage_date = ${usageDate}
              returning tokens_reserved as "tokensReserved", in_flight as "inFlight"
            `);
            if (rows(countersResult).length !== 1) {
              throw new Error("A liquidação não encontrou o contador diário correspondente");
            }
            return {
              applied: true,
              usageId,
              budgetTokens,
              durationMs: durationMs(now, claimed.reservedAt),
            };
          },
        );

      let result: SettlementResult;
      try {
        result = await applySettlement();
      } catch (error) {
        // A client-side failure may happen after PostgreSQL committed. Replaying
        // the guarded transition is safe: it either applies a rolled-back
        // settlement or returns the already-settled no-op.
        logJson("warn", "ai.budget_settlement_retry", {
          tenantId: dependencies.identity.tenantId,
          usageId,
          outcome,
          error,
        });
        result = await applySettlement();
      }

      logJson("info", "ai.budget_settled", {
        tenantId: dependencies.identity.tenantId,
        usageId,
        budget: result.budgetTokens,
        real: settlement.kind === "known" ? settlement.realTokens : null,
        usageUnknownReason: settlement.kind === "unknown" ? settlement.reason : null,
        durationMs: result.durationMs,
        outcome: persistedOutcome,
        applied: result.applied,
      });
      return result;
    },

    async sweepOrphans(tenantId, options = {}): Promise<SweepResult> {
      assertIdentityTenant(dependencies.identity, tenantId);
      const now = options.now ?? clock.now();
      assertDate(now, "now");
      const result = await transactionRunner.run(dependencies.identity, (transaction) =>
        sweepOrphansInTransaction(transaction, tenantId, now, config),
      );
      logExpired(tenantId, now, result);
      return { expiredCount: result.expiredCount, usageIds: result.usageIds };
    },

    async reconcileUnknownUsage(tenantId, options = {}): Promise<ReconcileUnknownResult> {
      assertIdentityTenant(dependencies.identity, tenantId);
      const now = options.now ?? clock.now();
      assertDate(now, "now");
      const minAgeMs = options.minAgeMs ?? DEFAULT_RECONCILE_MIN_AGE_MS;
      // Um lote de 0 trataria nada e ainda assim sairia com sucesso — o mesmo
      // fail-open silencioso que o TRILHO A fechou. `assertPositiveInteger` recusa.
      // O teto é recusado, e não aparado: o CLI já rejeita `> MAX`, e um clamp
      // silencioso aqui daria dois contratos para a mesma opção (defeito D3).
      const batchSize = options.batchSize ?? DEFAULT_RECONCILE_BATCH_SIZE;
      assertNonNegativeInteger("minAgeMs", minAgeMs);
      assertPositiveInteger("batchSize", batchSize);
      if (batchSize > MAX_RECONCILE_BATCH_SIZE) {
        throw new RangeError(`${MAX_RECONCILE_BATCH_SIZE} é o teto de batchSize`);
      }
      const result = await transactionRunner.run(dependencies.identity, (transaction) =>
        reconcileUnknownInTransaction(transaction, tenantId, now, minAgeMs, batchSize),
      );
      logReconciliationFailed(tenantId, now, result);
      return {
        scannedCount: result.scannedCount,
        failedCount: result.failed.length,
        usageIds: result.failed.map((row) => row.usageId),
        oldestAgeMs: result.oldestAgeMs,
      };
    },

    async releaseUnknownReservation(
      tenantId,
      usageId,
      options = {},
    ): Promise<ReleaseUnknownResult> {
      assertIdentityTenant(dependencies.identity, tenantId);
      assertText("usageId", usageId);
      const now = options.now ?? clock.now();
      assertDate(now, "now");
      const result = await transactionRunner.run(dependencies.identity, (transaction) =>
        releaseUnknownInTransaction(transaction, tenantId, usageId, now),
      );
      if (result.applied) {
        logJson("warn", "ai.reservation_released", {
          tenantId,
          usageId,
          budget: result.releasedTokens,
          real: null,
          outcome: RESERVATION_RELEASED_OUTCOME,
          actor: dependencies.identity.userId,
        });
      }
      return result;
    },
  };
}
