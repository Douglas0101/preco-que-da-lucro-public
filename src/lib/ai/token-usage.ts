import { z } from "zod";

/**
 * Token accounting for the AI gateway (INV-006 — "unknown is not zero").
 *
 * The gateway response is an external, untrusted envelope: `usage` may be absent,
 * partially filled, or malformed. Coercing any of those into `0` asserts a measurement
 * that was never made and hides real consumption from the `AI_DAILY_*` ceiling.
 *
 * This module is the single place that decides whether usage is *known*. It never
 * produces a known value out of an absent or invalid one.
 */

/**
 * NOT `.strict()` on purpose: real OpenAI-compatible gateways send extra keys (e.g.
 * `total_tokens`). Strictness here would classify every real response as invalid and
 * turn a correctness fix into an outage. Unknown keys are stripped, not rejected.
 */
export const aiUsageSchema = z.object({
  prompt_tokens: z.number().int().nonnegative().optional(),
  completion_tokens: z.number().int().nonnegative().optional(),
});

export type TokenUsageUnknownReason = "absent" | "partial" | "invalid";

export type TokenUsage =
  | { kind: "known"; inputTokens: number; outputTokens: number }
  | { kind: "unknown"; reason: TokenUsageUnknownReason };

/**
 * Classifies raw gateway `usage` into known or unknown.
 *
 * - absent/null                       -> unknown("absent")
 * - not matching the schema (string, negative, NaN, Infinity, float, non-object)
 *                                     -> unknown("invalid")
 * - one of the two counts missing     -> unknown("partial")
 * - both counts present (including the explicit pair 0/0) -> known
 *
 * `z.number()` rejects NaN, `.int()` rejects Infinity and fractions, and
 * `.nonnegative()` rejects negatives, so no invalid value can reach `known`.
 */
export function parseAiUsage(raw: unknown): TokenUsage {
  if (raw === null || raw === undefined) return { kind: "unknown", reason: "absent" };

  const parsed = aiUsageSchema.safeParse(raw);
  if (!parsed.success) return { kind: "unknown", reason: "invalid" };

  const { prompt_tokens: inputTokens, completion_tokens: outputTokens } = parsed.data;
  if (inputTokens === undefined || outputTokens === undefined) {
    return { kind: "unknown", reason: "partial" };
  }

  return { kind: "known", inputTokens, outputTokens };
}

/** Total tokens for a known usage; callers must narrow first. */
export function knownTotalTokens(usage: TokenUsage & { kind: "known" }): number {
  return usage.inputTokens + usage.outputTokens;
}
