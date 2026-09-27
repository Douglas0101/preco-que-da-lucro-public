import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { decimalStringSchema } from "@/lib/financial-values";
import { logJson } from "@/lib/structured-logger";
import { applicationMetrics } from "@/instrumentation/telemetry";
import { requireDatabaseAuth } from "@/middleware/request-context";
import {
  calculateBreakEvenSummary,
  type BreakEvenServiceResult,
  type BreakEvenServiceStatus,
} from "@/server/services/break-even.service";
import {
  calculationSnapshotService,
  deriveSnapshotIdempotencyKey,
} from "@/server/services/calculation-snapshot.service";
import { FINANCE_ENGINE_VERSION } from "@/server/services/financial.service";

/**
 * `app.financial.states` só aceita `ok | incomplete | invalid` — o conjunto
 * está pinnado em `src/test/financial-metrics.test.ts` e é o que
 * `scripts/obs/error-budget.ts` classifica. O ponto de equilíbrio tem
 * vocabulário próprio e não casa um a um:
 *
 * - `reachable`    → `ok`         calculou e devolveu o valor;
 * - `unreachable`  → `incomplete` não devolveu valor (`rawUnits: null`) e não
 *                    é erro — margem de contribuição não-positiva. Declará-lo
 *                    `ok` esconderia o caso; `incomplete` cai em `monitored`
 *                    no error-budget, nunca em `financial_critical`;
 * - `invalid`      → `invalid`    entradas rejeitadas.
 *
 * O registro é aqui e não em `calculateBreakEvenSummary` porque o cálculo é
 * client-safe: gravar métrica dentro dele puxaria `telemetry.ts` para o grafo
 * do browser.
 */
function breakEvenState(status: BreakEvenServiceStatus): "ok" | "incomplete" | "invalid" {
  if (status === "reachable") return "ok";
  return status === "invalid" ? "invalid" : "incomplete";
}

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
    applicationMetrics.financialStates.add(1, {
      state: breakEvenState(result.status),
      engine_version: FINANCE_ENGINE_VERSION,
    });
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
