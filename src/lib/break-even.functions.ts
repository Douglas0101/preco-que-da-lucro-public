import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { decimalStringSchema } from "@/lib/financial-values";
import { logJson } from "@/lib/structured-logger";
import { applicationMetrics } from "@/instrumentation/telemetry";
import { requireDatabaseAuth } from "@/middleware/request-context";
import {
  calculateBreakEvenSummary,
  type BreakEvenServiceResult,
} from "@/server/services/break-even.service";
import {
  calculationSnapshotService,
  deriveSnapshotIdempotencyKey,
} from "@/server/services/calculation-snapshot.service";
import { FINANCE_ENGINE_VERSION } from "@/server/services/financial.service";

export const breakEvenInput = z.object({
  fixedExpenses: z.array(decimalStringSchema).max(500),
  price: decimalStringSchema,
  contributionMargin: decimalStringSchema,
  contributionMarginPct: decimalStringSchema,
  desiredProfit: decimalStringSchema.nullable(),
  unitMode: z.enum(["discrete", "continuous"]),
});

export type BreakEvenInput = z.input<typeof breakEvenInput>;

export const calculateBreakEven = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) => breakEvenInput.parse(input))
  .handler(async ({ data, context }): Promise<BreakEvenServiceResult> => {
    const result = calculateBreakEvenSummary(data);
    try {
      const inputs = JSON.parse(JSON.stringify(data)) as Record<string, unknown>;
      await calculationSnapshotService.append(context.requestContext, {
        entityType: "break_even_scenario",
        entityId: null,
        calculationType: "break_even",
        idempotencyKey: deriveSnapshotIdempotencyKey({
          calculationType: "break_even",
          entityType: "break_even_scenario",
          entityId: null,
          engineVersion: FINANCE_ENGINE_VERSION,
          inputs,
        }),
        inputs,
        outputs: JSON.parse(JSON.stringify(result)) as Record<string, unknown>,
        engineVersion: FINANCE_ENGINE_VERSION,
      });
      applicationMetrics.snapshotCreatedTotal.add(1, { type: "break_even" });
    } catch (error) {
      applicationMetrics.snapshotFailureTotal.add(1, { type: "break_even" });
      logJson("warn", "break_even.snapshot_failed", {
        message: error instanceof Error ? error.message : "unknown",
      });
    }
    return result;
  });
