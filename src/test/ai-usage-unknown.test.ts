import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import type { DatabaseIdentity, DatabaseTransaction, TransactionManager } from "@/db/client.server";
import {
  createBudgetLedger,
  type ReserveResult,
  type ReservedUsage,
} from "@/lib/ai/budget-ledger.server";

/**
 * INV-006 — settle with an *unknown* measurement must not assert a zero.
 *
 * These tests capture the SQL the ledger emits and read the bound parameters by
 * position, so they fail if `real_tokens` ever receives a number on the unknown
 * path, or if the daily counters are moved by a settlement that measured nothing.
 */

interface CapturedStatement {
  text: string;
  params: unknown[];
}

/** Value bound to `column = $N` in the rendered statement. */
function boundTo(statement: CapturedStatement, column: string): unknown {
  const match = new RegExp(`${column} = \\$(\\d+)`).exec(statement.text);
  if (!match) throw new Error(`coluna ${column} não encontrada em: ${statement.text}`);
  return statement.params[Number(match[1]) - 1];
}

/**
 * The settle update of the daily counters — distinguished from the *reserve* update,
 * which also targets `ai_daily_budgets` but only ever adds to the reservation.
 */
function settleDailyStatements(statements: CapturedStatement[]): CapturedStatement[] {
  return statements.filter(
    (s) =>
      s.text.includes("update ai_daily_budgets") && s.text.includes("in_flight = in_flight - 1"),
  );
}

function createCapturingLedger() {
  const dialect = new PgDialect();
  const statements: CapturedStatement[] = [];
  const identity: DatabaseIdentity = { userId: "user-1", tenantId: "tenant-1", roles: ["member"] };
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
  return { ledger: createBudgetLedger({ identity, transactionManager }), identity, statements };
}

async function reserve(
  ledger: ReturnType<typeof createCapturingLedger>["ledger"],
  tenantId: string,
) {
  const reservation = await ledger.reserveAtomic(tenantId, 1_000, {
    kind: "chat",
    roundNo: 1,
    now: new Date("2026-09-01T10:00:00Z"),
  });
  if (reservation.status !== "reserved") throw new Error("reserveAtomic recusou inesperadamente");
  return reservation as ReservedUsage & ReserveResult;
}

describe("settle — uso desconhecido (INV-006, variante B)", () => {
  it("grava real_tokens NULL e outcome 'usage_unknown' quando a medição é desconhecida", async () => {
    const { ledger, identity, statements } = createCapturingLedger();
    const reservation = await reserve(ledger, identity.tenantId);

    const result = await ledger.settle(
      reservation.usageId,
      { kind: "unknown", reason: "absent" },
      "success",
      { now: new Date("2026-09-01T10:00:30Z") },
    );

    expect(result.applied).toBe(true);
    const claim = statements.find((s) => s.text.includes("returning budget_tokens"));
    expect(claim).toBeDefined();
    expect(boundTo(claim!, "real_tokens")).toBeNull();
    expect(boundTo(claim!, "outcome")).toBe("usage_unknown");
  });

  it("NÃO libera a reserva e NÃO incrementa os contadores de token", async () => {
    const { ledger, identity, statements } = createCapturingLedger();
    const reservation = await reserve(ledger, identity.tenantId);

    await ledger.settle(reservation.usageId, { kind: "unknown", reason: "partial" }, "success", {
      now: new Date("2026-09-01T10:00:30Z"),
      toolCalls: 2,
    });

    const daily = settleDailyStatements(statements);
    expect(daily).toHaveLength(1);
    // A chamada terminou: não está mais em voo.
    expect(daily[0]!.text).toMatch(/in_flight = in_flight - 1/);
    // Mas a reserva permanece retida: liberá-la afirmaria consumo zero não medido.
    expect(daily[0]!.text).not.toMatch(/tokens_reserved = tokens_reserved -/);
    expect(daily[0]!.text).not.toMatch(/input_tokens = input_tokens \+/);
    expect(daily[0]!.text).not.toMatch(/output_tokens = output_tokens \+/);
    // Contagem de ferramentas é medida (não deriva de `usage`), então segue contada.
    expect(daily[0]!.text).toMatch(/tool_call_count = tool_call_count \+/);
  });

  it("distinguishes 'absent', 'partial' and 'invalid' without asserting counts", async () => {
    for (const reason of ["absent", "partial", "invalid"] as const) {
      const { ledger, identity, statements } = createCapturingLedger();
      const reservation = await reserve(ledger, identity.tenantId);
      await ledger.settle(reservation.usageId, { kind: "unknown", reason }, "success");
      const claim = statements.find((s) => s.text.includes("returning budget_tokens"));
      expect(boundTo(claim!, "real_tokens")).toBeNull();
      expect(boundTo(claim!, "outcome")).toBe("usage_unknown");
    }
  });

  it("REGRESSÃO: o caminho numérico legado continua idêntico (libera reserva e incrementa)", async () => {
    const { ledger, identity, statements } = createCapturingLedger();
    const reservation = await reserve(ledger, identity.tenantId);

    await ledger.settle(reservation.usageId, 300, "success", {
      now: new Date("2026-09-01T10:00:30Z"),
      inputTokens: 100,
      outputTokens: 200,
    });

    const claim = statements.find((s) => s.text.includes("returning budget_tokens"));
    expect(boundTo(claim!, "real_tokens")).toBe(300);
    expect(boundTo(claim!, "outcome")).toBe("success");
    const daily = settleDailyStatements(statements)[0];
    expect(daily!.text).toMatch(/tokens_reserved = tokens_reserved -/);
    expect(daily!.text).toMatch(/input_tokens = input_tokens \+/);
    expect(daily!.text).toMatch(/output_tokens = output_tokens \+/);
  });

  it("TokenUsage conhecido usa os valores medidos, não os de options", async () => {
    const { ledger, identity, statements } = createCapturingLedger();
    const reservation = await reserve(ledger, identity.tenantId);

    await ledger.settle(
      reservation.usageId,
      { kind: "known", inputTokens: 120, outputTokens: 35 },
      "success",
      { now: new Date("2026-09-01T10:00:30Z"), inputTokens: 999, outputTokens: 999 },
    );

    const claim = statements.find((s) => s.text.includes("returning budget_tokens"));
    expect(boundTo(claim!, "real_tokens")).toBe(155);
    const daily = settleDailyStatements(statements)[0];
    expect(daily!.params).toContain(120);
    expect(daily!.params).toContain(35);
    expect(daily!.params).not.toContain(999);
  });

  it("zero explícito conhecido liquida com zero (não confundir com desconhecido)", async () => {
    const { ledger, identity, statements } = createCapturingLedger();
    const reservation = await reserve(ledger, identity.tenantId);

    await ledger.settle(
      reservation.usageId,
      { kind: "known", inputTokens: 0, outputTokens: 0 },
      "success",
    );

    const claim = statements.find((s) => s.text.includes("returning budget_tokens"));
    expect(boundTo(claim!, "real_tokens")).toBe(0);
    expect(boundTo(claim!, "outcome")).toBe("success");
    const daily = settleDailyStatements(statements)[0];
    expect(daily!.text).toMatch(/tokens_reserved = tokens_reserved -/);
  });
});
