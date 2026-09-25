import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";
import { requireDatabaseAuth } from "@/middleware/request-context";
import {
  runFinancialSimulation,
  simulationParamsSchema,
} from "@/server/services/financial.service";
import { simulationService } from "@/server/services/simulation.service";

type SerializableJson =
  string | number | boolean | null | SerializableJson[] | { [key: string]: SerializableJson };
type SerializableJsonObject = { [key: string]: SerializableJson };

function toSerializableJsonObject(value: Record<string, unknown>): SerializableJsonObject {
  return JSON.parse(JSON.stringify(value)) as SerializableJsonObject;
}

/** Financial scenarios run inside the authenticated BFF, never in React. */
export const runSimulation = createServerFn({ method: "POST" })
  .middleware([requireDatabaseAuth])
  .validator((input: unknown) => simulationParamsSchema.parse(input))
  .handler(async ({ data }) => runFinancialSimulation(data));

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
    return rows.map(mapSimulation);
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
