import { describe, expect, it, vi } from "vitest";
import { applicationMetrics } from "@/instrumentation/telemetry";
import {
  FINANCE_ENGINE_VERSION,
  runFinancialSimulation,
} from "@/server/services/financial.service";

describe("financial simulation BFF contract", () => {
  it("serializa todos os valores financeiros como strings decimais", () => {
    const result = runFinancialSimulation({
      price: "20",
      unitCost: "5",
      taxRate: "10",
      fees: [],
      fixedExpenses: "101",
      volume: "10.1",
      volumeSource: "manual_simulation",
    });

    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(typeof result.value.price).toBe("string");
    expect(typeof result.value.result).toBe("string");
    expect(typeof result.value.volume).toBe("string");
    expect(typeof result.value.breakEvenUnits.rawUnits).toBe("string");
    expect(result.value.resultSign).toBe("positive");
  });

  it("registra a versão do motor financeiro a cada simulação executada", () => {
    const add = vi.spyOn(applicationMetrics.financialEngineVersion, "add");

    runFinancialSimulation({
      price: "20",
      unitCost: "5",
      taxRate: "10",
      fees: [],
      fixedExpenses: "101",
      volume: "10.1",
      volumeSource: "manual_simulation",
    });
    runFinancialSimulation({
      price: null,
      unitCost: null,
      taxRate: null,
      fees: [],
      fixedExpenses: null,
      volume: null,
      volumeSource: "unknown",
    });

    const versionCalls = add.mock.calls.filter(
      ([, attributes]) => attributes !== undefined && "version" in attributes,
    );
    expect(versionCalls).toEqual([
      [1, { version: FINANCE_ENGINE_VERSION }],
      [1, { version: FINANCE_ENGINE_VERSION }],
    ]);
  });

  it("registra estado e versão do motor em todos os caminhos, inclusive volume real", () => {
    const add = vi.spyOn(applicationMetrics.financialStates, "add");

    runFinancialSimulation({
      price: "20",
      unitCost: "5",
      taxRate: "10",
      fees: [],
      fixedExpenses: "101",
      volume: "10.1",
      volumeSource: "manual_simulation",
    });
    runFinancialSimulation({
      price: null,
      unitCost: null,
      taxRate: null,
      fees: [],
      fixedExpenses: null,
      volume: null,
      volumeSource: "unknown",
    });
    runFinancialSimulation({
      price: "NaN",
      unitCost: "5",
      taxRate: "10",
      fees: [],
      fixedExpenses: "101",
      volume: "10",
      volumeSource: "manual_simulation",
    });
    runFinancialSimulation({
      price: "20",
      unitCost: "5",
      taxRate: "0",
      fees: [],
      fixedExpenses: "100",
      volume: "10",
      volumeSource: "real",
    });

    const stateCalls = add.mock.calls.filter(
      ([, attributes]) => attributes !== undefined && "state" in attributes,
    );
    const versionCalls = add.mock.calls.filter(
      ([, attributes]) => attributes !== undefined && "version" in attributes,
    );
    expect(stateCalls).toEqual([
      [1, { state: "ok", engine_version: FINANCE_ENGINE_VERSION }],
      [1, { state: "incomplete", engine_version: FINANCE_ENGINE_VERSION }],
      [1, { state: "invalid", engine_version: FINANCE_ENGINE_VERSION }],
      [1, { state: "invalid", engine_version: FINANCE_ENGINE_VERSION }],
    ]);
    expect(versionCalls).toEqual([
      [1, { version: FINANCE_ENGINE_VERSION }],
      [1, { version: FINANCE_ENGINE_VERSION }],
      [1, { version: FINANCE_ENGINE_VERSION }],
      [1, { version: FINANCE_ENGINE_VERSION }],
    ]);
  });

  it("mantém unknown como incomplete e entradas não finitas como invalid", () => {
    const incomplete = runFinancialSimulation({
      price: "20",
      unitCost: null,
      taxRate: "0.1",
      fees: [],
      fixedExpenses: "100",
      volume: "10",
      volumeSource: "manual_simulation",
    });
    expect(incomplete.status).toBe("incomplete");

    const invalid = runFinancialSimulation({
      price: "NaN",
      unitCost: "5",
      taxRate: "0.1",
      fees: [],
      fixedExpenses: "100",
      volume: "10",
      volumeSource: "manual_simulation",
    });
    expect(invalid).toMatchObject({
      status: "invalid",
      errors: [expect.objectContaining({ code: "INVALID_NUMBER", field: "price" })],
    });
  });

  it("não trata volume real arbitrário como simulação factual", () => {
    expect(
      runFinancialSimulation({
        price: "20",
        unitCost: "5",
        taxRate: "0",
        fees: [],
        fixedExpenses: "100",
        volume: "10",
        volumeSource: "real",
      }),
    ).toMatchObject({
      status: "invalid",
      errors: [expect.objectContaining({ code: "INVALID_VOLUME_SOURCE" })],
    });
  });
});
