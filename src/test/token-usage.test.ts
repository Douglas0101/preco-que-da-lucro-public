import { describe, expect, it } from "vitest";
import { aiUsageSchema, knownTotalTokens, parseAiUsage } from "@/lib/ai/token-usage";

/**
 * INV-006 — "unknown is not zero".
 *
 * The gateway response is external input: `usage` may be absent, partial or malformed.
 * None of those may become a known count, and an explicit 0/0 pair must stay known.
 */
describe("parseAiUsage — classificação de uso de tokens (INV-006)", () => {
  it("usage ausente é desconhecido, nunca zero", () => {
    expect(parseAiUsage(undefined)).toEqual({ kind: "unknown", reason: "absent" });
    expect(parseAiUsage(null)).toEqual({ kind: "unknown", reason: "absent" });
  });

  it("usage com campo ausente é desconhecido (partial)", () => {
    expect(parseAiUsage({ prompt_tokens: 10 })).toEqual({ kind: "unknown", reason: "partial" });
    expect(parseAiUsage({ completion_tokens: 5 })).toEqual({ kind: "unknown", reason: "partial" });
    expect(parseAiUsage({ prompt_tokens: undefined, completion_tokens: undefined })).toEqual({
      kind: "unknown",
      reason: "partial",
    });
    expect(parseAiUsage({})).toEqual({ kind: "unknown", reason: "partial" });
  });

  it("usage inválido é desconhecido (invalid) — nunca zero", () => {
    expect(parseAiUsage("10")).toEqual({ kind: "unknown", reason: "invalid" });
    expect(parseAiUsage(10)).toEqual({ kind: "unknown", reason: "invalid" });
    expect(parseAiUsage({ prompt_tokens: -1, completion_tokens: 5 })).toEqual({
      kind: "unknown",
      reason: "invalid",
    });
    expect(parseAiUsage({ prompt_tokens: Number.NaN, completion_tokens: 5 })).toEqual({
      kind: "unknown",
      reason: "invalid",
    });
    expect(parseAiUsage({ prompt_tokens: Number.POSITIVE_INFINITY, completion_tokens: 5 })).toEqual(
      {
        kind: "unknown",
        reason: "invalid",
      },
    );
    expect(parseAiUsage({ prompt_tokens: 1.5, completion_tokens: 5 })).toEqual({
      kind: "unknown",
      reason: "invalid",
    });
    expect(parseAiUsage({ prompt_tokens: { nested: 1 }, completion_tokens: 5 })).toEqual({
      kind: "unknown",
      reason: "invalid",
    });
  });

  it("zero explícito continua sendo conhecido", () => {
    expect(parseAiUsage({ prompt_tokens: 0, completion_tokens: 0 })).toEqual({
      kind: "known",
      inputTokens: 0,
      outputTokens: 0,
    });
    expect(knownTotalTokens({ kind: "known", inputTokens: 0, outputTokens: 0 })).toBe(0);
  });

  it("uso conhecido positivo é somado corretamente", () => {
    const parsed = parseAiUsage({ prompt_tokens: 120, completion_tokens: 35 });
    expect(parsed).toEqual({ kind: "known", inputTokens: 120, outputTokens: 35 });
    expect(
      knownTotalTokens(parsed as { kind: "known"; inputTokens: number; outputTokens: number }),
    ).toBe(155);
  });

  it("campos extras do gateway real não invalidam o payload (não é strict)", () => {
    // OpenAI-compatible gateways enviam `total_tokens`; rigidez aqui quebraria produção.
    expect(parseAiUsage({ prompt_tokens: 120, completion_tokens: 35, total_tokens: 155 })).toEqual({
      kind: "known",
      inputTokens: 120,
      outputTokens: 35,
    });
  });

  it("FALSIFICAÇÃO: nenhuma entrada produz 'known' sem medição", () => {
    const hostileInputs: unknown[] = [
      undefined,
      null,
      {},
      [],
      "0",
      0,
      { prompt_tokens: null, completion_tokens: null },
      { prompt_tokens: "0", completion_tokens: "0" },
      { prompt_tokens: -0.0001, completion_tokens: 0 },
    ];
    for (const input of hostileInputs) {
      expect(parseAiUsage(input).kind).not.toBe("known");
    }
  });

  it("o schema é a única porta: safeParse não lança em entrada hostil", () => {
    expect(() => aiUsageSchema.safeParse(Symbol("x"))).not.toThrow();
    expect(aiUsageSchema.safeParse({ prompt_tokens: 1 }).success).toBe(true);
  });
});
