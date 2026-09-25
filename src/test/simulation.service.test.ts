import { describe, expect, it } from "vitest";
import type { Simulation } from "@/db/schema";
import { toDecimalString } from "@/lib/financial-values";
import type { RequestContext } from "@/lib/request-context";
import type {
  SimulationRecordWrite,
  SimulationRepository,
} from "@/server/repositories/simulation.repository";
import {
  DefaultSimulationService,
  type SimulationWrite,
} from "@/server/services/simulation.service";
import { contextWithRole } from "./helpers/request-context";

const validParams: SimulationWrite["params"] = {
  price: toDecimalString("20"),
  unitCost: toDecimalString("8"),
  fixedExpenses: toDecimalString("100"),
  volume: toDecimalString("20"),
  taxRate: toDecimalString("0.1"),
  fees: [{ percentage: toDecimalString("0.02") }],
  volumeSource: "manual_simulation",
};

class FakeSimulationRepository implements SimulationRepository {
  lastWrite: SimulationRecordWrite | undefined;

  async list(): Promise<Simulation[]> {
    return [];
  }

  async append(_context: RequestContext, input: SimulationRecordWrite) {
    this.lastWrite = input;
    return {} as Simulation;
  }
}

class FakeTransaction {
  insert() {
    return this;
  }
  values() {
    return this;
  }
  onConflictDoNothing() {
    return this;
  }
  returning() {
    const rowPromise = Promise.resolve([{ id: "snapshot-id" }]);
    return {
      then: (resolve: (value: unknown) => void) => rowPromise.then(resolve) as Promise<void>,
    };
  }
  select() {
    return this;
  }
  from() {
    return this;
  }
  where() {
    return this;
  }
  limit() {
    return this;
  }
  orderBy() {
    return this;
  }
  then<TResult1 = unknown, TResult2 = never>(
    onfulfilled?: ((value: unknown) => TResult1 | PromiseLike<TResult1>) | null,
    onrejected?: ((reason: unknown) => TResult2 | PromiseLike<TResult2>) | null,
  ) {
    return Promise.resolve([{ id: "snapshot-id" }]).then(onfulfilled, onrejected) as PromiseLike<
      TResult1 | TResult2
    >;
  }
}

describe("SimulationService", () => {
  it("calcula no servidor e persiste versão/result sem aceitar payload derivado", async () => {
    const repository = new FakeSimulationRepository();
    const service = new DefaultSimulationService(repository);
    const context = contextWithRole("owner");
    (context as { transaction: unknown }).transaction = new FakeTransaction();

    await service.save(context, {
      name: "Cenário manual",
      params: validParams,
    });

    expect(repository.lastWrite?.scenarioType).toBe("manual_simulation");
    expect(repository.lastWrite?.engineVersion).toBe("finance-engine/2.0.0");
    expect(repository.lastWrite?.result).toMatchObject({ status: "ok" });
    expect(repository.lastWrite?.params).toEqual(validParams);
  });

  it("não persiste cenário incompleto ou origem que ainda não tem fonte server-side", async () => {
    const repository = new FakeSimulationRepository();
    const service = new DefaultSimulationService(repository);

    await expect(
      service.save(contextWithRole("owner"), {
        name: "Incompleto",
        params: { ...validParams, price: null },
      }),
    ).rejects.toThrow("SIMULATION_NOT_PERSISTABLE");
    await expect(
      service.save(contextWithRole("owner"), {
        name: "Forecast",
        params: { ...validParams, volumeSource: "forecast" },
      }),
    ).rejects.toThrow("SIMULATION_SOURCE_NOT_PERSISTABLE");
    expect(repository.lastWrite).toBeUndefined();
  });
});
