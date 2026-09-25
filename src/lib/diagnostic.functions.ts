import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireDatabaseAuth } from "@/middleware/request-context";
import { decimalStringSchema } from "@/lib/financial-values";
import { getDiagnostic as getDiagnosticService } from "@/server/services/diagnostic.service";

const diagnosticInput = z
  .object({
    product_id: z.string().uuid(),
    non_percentage_variable_unit_cost: decimalStringSchema.nullable().optional(),
    target_contribution_rate: decimalStringSchema.nullable().optional(),
  })
  .strict();

const asNullableNumber = (value: string | null | undefined): number | null =>
  value == null ? null : Number(value);

/** Server-side diagnostic (WS-02): canonical analysis never runs in React. */
export const getDiagnostic = createServerFn({ method: "GET" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) => diagnosticInput.parse(input))
  .handler(async ({ data, context }) =>
    getDiagnosticService(context.requestContext, {
      productId: data.product_id,
      nonPercentageVariableUnitCost: asNullableNumber(data.non_percentage_variable_unit_cost),
      targetContributionRate: asNullableNumber(data.target_contribution_rate),
    }),
  );
