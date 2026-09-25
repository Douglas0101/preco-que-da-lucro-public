import { afterEach, describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { DatabaseIdentity, DatabaseTransaction, TransactionManager } from "@/db/client.server";
import {
  assertPricingConfigForBoot,
  createBudgetLedger,
  estimateModelCost,
  modelTokenPricesFromEnv,
  type ModelTokenPrice,
  type ReservedUsage,
  type ReserveResult,
} from "@/lib/ai/budget-ledger.server";
import { redactLogValue } from "@/lib/structured-logger";

const PRICES: Record<string, ModelTokenPrice> = {
  "google/gemini-3.6-flash": { inputPerMillion: 0.1, outputPerMillion: 0.4 },
};

afterEach(() => {
  delete process.env.AI_MODEL_PRICING_JSON;
});

describe("estimateModelCost", () => {
  it("computes a known cost string for a priced model and non-negative tokens", () => {
    const result = estimateModelCost("google/gemini-3.6-flash", 1_000_000, 500_000, PRICES);
    expect(result).toEqual({ cost: "0.3000", status: "known" });
  });

  it("returns unknown for a model without configured price", () => {
    expect(estimateModelCost("not-a-model", 1_000, 1_000, PRICES)).toEqual({
      cost: null,
      status: "unknown",
    });
  });

  it("returns unknown for a null model name", () => {
    expect(estimateModelCost(null, 1_000, 1_000, PRICES)).toEqual({
      cost: null,
      status: "unknown",
    });
  });

  it("flags negative or non-finite token counts as invalid", () => {
    expect(estimateModelCost("google/gemini-3.6-flash", -1, 10, PRICES)).toEqual({
      cost: null,
      status: "invalid",
    });
    expect(estimateModelCost("google/gemini-3.6-flash", 1.5, 10, PRICES)).toEqual({
      cost: null,
      status: "invalid",
    });
    expect(estimateModelCost("google/gemini-3.6-flash", Number.NaN, 10, PRICES)).toEqual({
      cost: null,
      status: "invalid",
    });
    expect(
      estimateModelCost("google/gemini-3.6-flash", 10, Number.POSITIVE_INFINITY, PRICES),
    ).toEqual({ cost: null, status: "invalid" });
  });

  it("allows a zero cost string when prices are zero by config (known, not unknown)", () => {
    const zeroPriced = { model: { inputPerMillion: 0, outputPerMillion: 0 } };
    expect(estimateModelCost("model", 100, 100, zeroPriced)).toEqual({
      cost: "0.0000",
      status: "known",
    });
  });

  it("uses AI_MODEL_PRICING_JSON when provided as env-compatible input", () => {
    const env = {
      AI_MODEL_PRICING_JSON: JSON.stringify({
        "custom/model": { inputPerMillion: 0.5, outputPerMillion: 1.5 },
      }),
    };
    const prices = modelTokenPricesFromEnv(env);
    expect(prices["custom/model"]).toEqual({ inputPerMillion: 0.5, outputPerMillion: 1.5 });
    expect(prices["google/gemini-3.6-flash"]).toBeUndefined();
    expect(estimateModelCost("custom/model", 1_000_000, 0, prices)).toEqual({
      cost: "0.5000",
      status: "known",
    });
  });

  it("estimates via env defaults when no prices arg is passed", () => {
    expect(estimateModelCost("google/gemini-3.6-flash", 100_000, 100_000)).toEqual({
      cost: "0.0500",
      status: "known",
    });
  });
});

describe("modelTokenPricesFromEnv validation (API-001 §6.9, INV-014)", () => {
  it("uses documented defaults only when the variable is absent (config absent ≠ config invalid)", () => {
    expect(modelTokenPricesFromEnv({})["google/gemini-3.6-flash"]).toEqual({
      inputPerMillion: 0.1,
      outputPerMillion: 0.4,
    });
    expect(
      modelTokenPricesFromEnv({ AI_MODEL_PRICING_JSON: "" })["google/gemini-3.6-flash"],
    ).toEqual({ inputPerMillion: 0.1, outputPerMillion: 0.4 });
  });

  it("throws an explicit CONFIG_ERROR when the variable is set but malformed — never silent fallback", () => {
    const malformed: Record<string, string | undefined>[] = [
      { AI_MODEL_PRICING_JSON: "not-json" },
      { AI_MODEL_PRICING_JSON: "   " },
      { AI_MODEL_PRICING_JSON: "null" },
      { AI_MODEL_PRICING_JSON: "[]" },
      { AI_MODEL_PRICING_JSON: '"a string"' },
      { AI_MODEL_PRICING_JSON: JSON.stringify({ broken: { inputPerMillion: -1 } }) },
      { AI_MODEL_PRICING_JSON: JSON.stringify({ broken: { inputPerMillion: 0.1 } }) },
      {
        AI_MODEL_PRICING_JSON: JSON.stringify({
          broken: { inputPerMillion: "0.1", outputPerMillion: 0.4 },
        }),
      },
      { AI_MODEL_PRICING_JSON: JSON.stringify({ broken: 0.4 }) },
      {
        AI_MODEL_PRICING_JSON: JSON.stringify({
          "": { inputPerMillion: 0.1, outputPerMillion: 0.4 },
        }),
      },
      { AI_MODEL_PRICING_JSON: '{ "m": { "inputPerMillion": 1e999, "outputPerMillion": 0.4 } }' },
    ];
    for (const env of malformed) {
      expect(() => modelTokenPricesFromEnv(env)).toThrow(
        /^CONFIG_ERROR: AI_MODEL_PRICING_JSON inválida — /,
      );
    }
  });

  it("treats an explicitly set empty map as 'no pricing' instead of resurrecting defaults (INV-006)", () => {
    const prices = modelTokenPricesFromEnv({ AI_MODEL_PRICING_JSON: "{}" });
    expect(prices).toEqual({});
    expect(estimateModelCost("google/gemini-3.6-flash", 10, 10, prices)).toEqual({
      cost: null,
      status: "unknown",
    });
  });

  it("does not echo raw pricing values in the error message (§19.4)", () => {
    try {
      modelTokenPricesFromEnv({
        AI_MODEL_PRICING_JSON: JSON.stringify({
          "internal/model": { inputPerMillion: -0.123456, outputPerMillion: "987654321" },
        }),
      });
      expect.unreachable("should have thrown");
    } catch (error) {
      const message = (error as Error).message;
      expect(message).toMatch(/^CONFIG_ERROR: AI_MODEL_PRICING_JSON inválida — /);
      expect(message).not.toContain("-0.123456");
      expect(message).not.toContain("987654321");
    }
  });
});

describe("assertPricingConfigForBoot", () => {
  it("boots with defaults when the variable is unset (dev-friendly)", () => {
    expect(() => assertPricingConfigForBoot({})).not.toThrow();
    expect(assertPricingConfigForBoot({})["google/gemini-3.6-flash"]).toEqual({
      inputPerMillion: 0.1,
      outputPerMillion: 0.4,
    });
  });

  it("boots with a valid custom map", () => {
    const env = {
      AI_MODEL_PRICING_JSON: JSON.stringify({
        "custom/model": { inputPerMillion: 0.5, outputPerMillion: 1.5 },
      }),
    };
    expect(assertPricingConfigForBoot(env)).toEqual({
      "custom/model": { inputPerMillion: 0.5, outputPerMillion: 1.5 },
    });
  });

  it("fails fast when the variable is set but invalid", () => {
    expect(() => assertPricingConfigForBoot({ AI_MODEL_PRICING_JSON: "{" })).toThrow(
      /^CONFIG_ERROR: AI_MODEL_PRICING_JSON inválida — /,
    );
  });
});

describe("pricing redaction (§19.4)", () => {
  it("redacts pricing-shaped keys anywhere in a log payload", () => {
    const prices = { "google/gemini-3.6-flash": { inputPerMillion: 0.1, outputPerMillion: 0.4 } };
    expect(redactLogValue({ aiModelPricing: prices }, "aiModelPricing")).toBe("[REDACTED]");
    const nested = redactLogValue({
      config: { AI_MODEL_PRICING_JSON: "raw", pricing: prices, ai_model_pricing: prices },
    }) as { config: Record<string, unknown> };
    expect(nested.config.AI_MODEL_PRICING_JSON).toBe("[REDACTED]");
    expect(nested.config.pricing).toBe("[REDACTED]");
    expect(nested.config.ai_model_pricing).toBe("[REDACTED]");
    expect(nested.config).not.toHaveProperty("inputPerMillion");
  });
});

interface CapturedStatement {
  text: string;
  params: unknown[];
}

function createCapturingLedger() {
  const dialect = new PgDialect();
  const statements: CapturedStatement[] = [];
  const identity: DatabaseIdentity = {
    userId: "user-1",
    tenantId: "tenant-1",
    roles: ["member"],
  };
  const transactionManager = {
    async run<T>(_id: DatabaseIdentity, operation: (t: DatabaseTransaction) => Promise<T>) {
      const transaction = {
        async execute(query: SQL) {
          const rendered = dialect.sqlToQuery(query);
          const captured: CapturedStatement = {
            text: rendered.sql.toLowerCase(),
            params: rendered.params,
          };
          statements.push(captured);
          if (captured.text.includes("status = 'expired'")) return { rows: [] };
          if (captured.text.includes("returning budget_tokens")) {
            return { rows: [{ budgetTokens: 100, reservedAt: "2026-09-01T10:00:00.000Z" }] };
          }
          if (captured.text.includes("insert into ai_usage")) {
            return { rows: [{ usageId: "usage-1", reservedAt: "2026-09-01T10:00:00.000Z" }] };
          }
          if (captured.text.includes("update ai_daily_budgets")) {
            return { rows: [{ tokensReserved: 0, inFlight: 0 }] };
          }
          return { rows: [] };
        },
      } as unknown as DatabaseTransaction;
      return operation(transaction);
    },
  } as unknown as TransactionManager;
  const ledger = createBudgetLedger({ identity, transactionManager });
  return { ledger, identity, statements };
}

function requireReserved(reservation: ReserveResult): ReservedUsage {
  if (reservation.status !== "reserved") throw new Error("reserveAtomic unexpectedly rejected");
  return reservation;
}

describe("budget ledger contract (R3 reservation + INV-006)", () => {
  it("reserve and settle never write ai_usage.tool_execution_id (column stays NULL)", async () => {
    const { ledger, identity, statements } = createCapturingLedger();
    const reservation = await ledger.reserveAtomic(identity.tenantId, 1_000, {
      kind: "chat",
      roundNo: 1,
      now: new Date("2026-09-01T10:00:00Z"),
    });
    expect(reservation.status).toBe("reserved");
    await ledger.settle(requireReserved(reservation).usageId, 300, "success", {
      now: new Date("2026-09-01T10:00:30Z"),
      inputTokens: 100,
      outputTokens: 200,
    });
    const aiUsageStatements = statements.filter((s) => s.text.includes("ai_usage"));
    expect(aiUsageStatements.length).toBeGreaterThanOrEqual(2);
    for (const statement of aiUsageStatements) {
      expect(statement.text).not.toMatch(/tool_execution_id/);
    }
  });

  it("settle without cost writes NULL estimated_cost + 'unknown', never 0.0000 (INV-006 regression)", async () => {
    const { ledger, identity, statements } = createCapturingLedger();
    const reservation = await ledger.reserveAtomic(identity.tenantId, 1_000, {
      kind: "chat",
      roundNo: 1,
      now: new Date("2026-09-01T10:00:00Z"),
    });
    await ledger.settle(requireReserved(reservation).usageId, 300, "success", {
      now: new Date("2026-09-01T10:00:30Z"),
      inputTokens: 100,
      outputTokens: 200,
    });
    const claim = statements.find((s) => s.text.includes("returning budget_tokens"));
    expect(claim).toBeDefined();
    expect(claim?.params).toContain(null);
    expect(claim?.params).toContain("unknown");
    expect(claim?.params).not.toContain("0.0000");
    const daily = statements.find((s) => s.text.includes("estimated_cost_unknown_count"));
    expect(daily).toBeDefined();
    expect(daily?.text).not.toMatch(/estimated_cost = estimated_cost \+/);
  });

  it("settle with a known cost adds it to the daily estimated_cost total", async () => {
    const { ledger, identity, statements } = createCapturingLedger();
    const reservation = await ledger.reserveAtomic(identity.tenantId, 1_000, {
      kind: "chat",
      roundNo: 1,
      now: new Date("2026-09-01T10:00:00Z"),
    });
    await ledger.settle(requireReserved(reservation).usageId, 300, "success", {
      now: new Date("2026-09-01T10:00:30Z"),
      inputTokens: 100,
      outputTokens: 200,
      estimatedCost: "0.0500",
      costStatus: "known",
    });
    const claim = statements.find((s) => s.text.includes("returning budget_tokens"));
    expect(claim?.params).toContain("0.0500");
    expect(claim?.params).toContain("known");
    const daily = statements.find((s) =>
      s.text.match(/update ai_daily_budgets[\s\S]*estimated_cost = estimated_cost \+/),
    );
    expect(daily).toBeDefined();
  });
});
