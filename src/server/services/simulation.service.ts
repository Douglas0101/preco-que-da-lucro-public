import { assertTenantMutationAuthorized, type RequestContext } from "@/lib/request-context";
import { applicationMetrics } from "@/instrumentation/telemetry";
import {
  calculationSnapshotService,
  deriveSnapshotIdempotencyKey,
} from "@/server/services/calculation-snapshot.service";
import {
  simulationRepository,
  type SimulationRepository,
  type SimulationRecordWrite,
} from "@/server/repositories/simulation.repository";
import {
  FINANCE_ENGINE_VERSION,
  runFinancialSimulation,
  simulationParamsSchema,
  type SimulationParams,
} from "@/server/services/financial.service";
import type { Simulation } from "@/db/schema";

export interface SimulationWrite {
  productId?: string | null;
  name: string;
  params: SimulationParams;
}

export interface SimulationService {
  list(context: RequestContext): Promise<Simulation[]>;
  save(context: RequestContext, input: SimulationWrite): Promise<Simulation>;
}

export class DefaultSimulationService implements SimulationService {
  constructor(private readonly repository: SimulationRepository) {}

  list(context: RequestContext): Promise<Simulation[]> {
    return this.repository.list(context);
  }

  async save(context: RequestContext, input: SimulationWrite): Promise<Simulation> {
    assertTenantMutationAuthorized(context);
    const name = input.name.trim();
    if (!name || name.length > 160) throw new Error("INVALID_SIMULATION_NAME");
    const params = simulationParamsSchema.parse(input.params);
    if (params.volumeSource !== "manual_simulation") {
      throw new Error("SIMULATION_SOURCE_NOT_PERSISTABLE");
    }
    const result = runFinancialSimulation(params);
    if (result.status !== "ok") throw new Error("SIMULATION_NOT_PERSISTABLE");
    const record: SimulationRecordWrite = {
      productId: input.productId ?? null,
      name,
      params,
      result: JSON.parse(JSON.stringify(result)) as Record<string, unknown>,
      scenarioType: "manual_simulation",
      engineVersion: FINANCE_ENGINE_VERSION,
    };
    const row = await this.repository.append(context, record);
    applicationMetrics.simulationSavedTotal.add(1);
    const inputs = JSON.parse(JSON.stringify({ params })) as Record<string, unknown>;
    await calculationSnapshotService.append(context, {
      entityType: "simulation",
      entityId: row.id,
      calculationType: "simulation",
      idempotencyKey: deriveSnapshotIdempotencyKey({
        calculationType: "simulation",
        entityType: "simulation",
        entityId: row.id,
        engineVersion: FINANCE_ENGINE_VERSION,
        inputs,
      }),
      inputs,
      outputs: JSON.parse(JSON.stringify({ result })) as Record<string, unknown>,
      engineVersion: FINANCE_ENGINE_VERSION,
    });
    applicationMetrics.snapshotCreatedTotal.add(1, { type: "simulation" });
    return row;
  }
}

export const simulationService: SimulationService = new DefaultSimulationService(
  simulationRepository,
);
