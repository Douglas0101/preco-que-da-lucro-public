import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import type { CalculationResult } from "@/lib/finance";
import { decimalStringSchema } from "@/lib/financial-values";
import { outputSchema } from "@/lib/output-contract";
import { requireDatabaseAuth } from "@/middleware/request-context";
import {
  runFinancialSimulation,
  simulationParamsSchema,
  type DecimalScenarioResult,
} from "@/server/services/financial.service";
import { simulationService } from "@/server/services/simulation.service";

type SerializableJson =
  string | number | boolean | null | SerializableJson[] | { [key: string]: SerializableJson };
type SerializableJsonObject = { [key: string]: SerializableJson };

function toSerializableJsonObject(value: Record<string, unknown>): SerializableJsonObject {
  return JSON.parse(JSON.stringify(value)) as SerializableJsonObject;
}

/**
 * Contratos de saída do motor financeiro (DBT-25). O schema é derivado do tipo
 * de retorno real do serviço, não de um formulário em branco: o `satisfies`
 * abaixo prova em tempo de compilação que o contrato não promete menos nem
 * outra coisa do que `runFinancialSimulation` devolve.
 */
const calculationWarningOutput = z.object({
  code: z.string(),
  message: z.string(),
  field: z.string().optional(),
});

const missingFieldOutput = z.object({
  field: z.string(),
  reason: z.string().optional(),
});

const calculationErrorOutput = z.object({
  code: z.string(),
  message: z.string(),
  field: z.string().optional(),
});

/** Ponto de equilíbrio serializado: unidades nulas quando não há alcance. */
const breakEvenOutput = z.object({
  status: z.enum(["reachable", "unreachable", "invalid"]),
  rawUnits: decimalStringSchema.nullable(),
  roundedUnits: decimalStringSchema.nullable(),
  unitMode: z.enum(["discrete", "continuous"]),
  reason: z.literal("NON_POSITIVE_CONTRIBUTION").optional(),
  errors: z.array(calculationErrorOutput).optional(),
});

const decimalScenarioOutput = z.object({
  price: decimalStringSchema,
  unitCost: decimalStringSchema,
  variableCost: decimalStringSchema,
  contributionMargin: decimalStringSchema,
  contributionMarginPct: decimalStringSchema,
  breakEvenUnits: breakEvenOutput,
  breakEvenRevenue: decimalStringSchema.nullable(),
  volume: decimalStringSchema,
  volumeSource: z.enum(["real", "manual_simulation", "forecast"]),
  revenue: decimalStringSchema,
  totalVariable: decimalStringSchema,
  totalContribution: decimalStringSchema,
  result: decimalStringSchema,
  resultSign: z.enum(["positive", "zero", "negative"]),
}) satisfies z.ZodType<DecimalScenarioResult>;

/** União discriminada `ok`/`incomplete`/`invalid` do motor (§8.2 da V7). */
const scenarioResultOutput = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("ok"),
    value: decimalScenarioOutput,
    warnings: z.array(calculationWarningOutput),
  }),
  z.object({
    status: z.literal("incomplete"),
    missing: z.array(missingFieldOutput),
    warnings: z.array(calculationWarningOutput),
  }),
  z.object({
    status: z.literal("invalid"),
    errors: z.array(calculationErrorOutput),
  }),
]) satisfies z.ZodType<CalculationResult<DecimalScenarioResult>>;

/**
 * Linha persistida de simulação. `params`/`result` são `jsonb` do Postgres
 * (`SerializableJsonObject`): o contrato afirma que são JSON válido, sem fingir
 * conhecer o formato interno que o motor grava.
 */
const simulationOutput = z.object({
  id: z.string(),
  product_id: z.string().nullable(),
  tenant_id: z.string(),
  name: z.string(),
  params: z.record(z.string(), z.json()),
  result: z.record(z.string(), z.json()).nullable(),
  scenario_type: z.string(),
  engine_version: z.string(),
  created_at: z.string(),
  updated_at: z.string(),
}) satisfies z.ZodType<ReturnType<typeof mapSimulation>>;

const simulationsOutput = z.array(simulationOutput);

/** Financial scenarios run inside the authenticated BFF, never in React. */
export const runSimulation = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) => simulationParamsSchema.parse(input))
  .handler(async ({ data }) =>
    outputSchema(scenarioResultOutput, "financial.runSimulation", runFinancialSimulation(data)),
  );

const persistedSimulationInput = z
  .object({
    product_id: z.string().uuid().nullable().optional(),
    name: z.string().trim().min(1).max(160),
    params: simulationParamsSchema,
  })
  .strict();

function mapSimulation(row: Awaited<ReturnType<typeof simulationService.save>>) {
  return {
    id: row.id,
    product_id: row.productId,
    tenant_id: row.tenantId,
    name: row.name,
    params: toSerializableJsonObject(row.params),
    result: row.result == null ? null : toSerializableJsonObject(row.result),
    scenario_type: row.scenarioType,
    engine_version: row.engineVersion,
    created_at: row.createdAt.toISOString(),
    updated_at: row.updatedAt.toISOString(),
  };
}

export const listSimulations = createServerFn({ method: "GET" })
  .middleware([requireDatabaseAuth])
  .handler(async ({ context }) => {
    const rows = await simulationService.list(context.requestContext);
    return outputSchema(simulationsOutput, "financial.listSimulations", rows.map(mapSimulation));
  });

export const saveSimulation = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) => persistedSimulationInput.parse(input))
  .handler(async ({ data, context }) => {
    const row = await simulationService.save(context.requestContext, {
      productId: data.product_id,
      name: data.name,
      params: data.params,
    });
    return mapSimulation(row);
  });
