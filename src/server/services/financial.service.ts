import Decimal from "decimal.js";
import { z } from "zod";
import { applicationMetrics } from "@/instrumentation/telemetry";
import {
  calculateScenario,
  type CalculationResult,
  type BreakEvenResult,
  type FeeRow,
  type VolumeSource,
} from "@/lib/finance";
import { decimalStringSchema, toDecimalString, type DecimalString } from "@/lib/financial-values";

export const FINANCE_ENGINE_VERSION = "finance-engine/2.0.0" as const;

/** Canonical input shared by the execute and persist simulation boundaries. */
export const simulationParamsSchema = z
  .object({
    price: decimalStringSchema.nullable(),
    unitCost: decimalStringSchema.nullable(),
    fixedExpenses: decimalStringSchema.nullable(),
    volume: decimalStringSchema.nullable(),
    taxRate: decimalStringSchema.nullable(),
    fees: z.array(z.object({ percentage: decimalStringSchema.nullable() }).strict()).max(100),
    volumeSource: z.enum(["real", "manual_simulation", "forecast", "unknown"]),
  })
  .strict();

export type SimulationParams = z.infer<typeof simulationParamsSchema>;

export interface SimulationServiceInput {
  price: string | null;
  unitCost: string | null;
  taxRate: string | null;
  fees: Array<{ percentage: string | null }>;
  fixedExpenses: string | null;
  volume: string | null;
  volumeSource: VolumeSource;
}

export interface DecimalBreakEvenResult {
  status: "reachable" | "unreachable" | "invalid";
  rawUnits: DecimalString | null;
  roundedUnits: DecimalString | null;
  unitMode: "discrete" | "continuous";
  reason?: "NON_POSITIVE_CONTRIBUTION";
  errors?: Array<{ code: string; message: string; field?: string }>;
}

export interface DecimalScenarioResult {
  price: DecimalString;
  unitCost: DecimalString;
  variableCost: DecimalString;
  contributionMargin: DecimalString;
  contributionMarginPct: DecimalString;
  breakEvenUnits: DecimalBreakEvenResult;
  breakEvenRevenue: DecimalString | null;
  volume: DecimalString;
  volumeSource: Exclude<VolumeSource, "unknown">;
  revenue: DecimalString;
  totalVariable: DecimalString;
  totalContribution: DecimalString;
  result: DecimalString;
  resultSign: "positive" | "zero" | "negative";
}

function parseValue(value: string | null): number | null {
  if (value == null || value.trim() === "") return null;
  try {
    const decimal = new Decimal(value);
    return decimal.isFinite() ? decimal.toNumber() : Number.NaN;
  } catch {
    return Number.NaN;
  }
}

function serializationError(field: string): CalculationResult<never> {
  return {
    status: "invalid",
    errors: [
      {
        code: "DECIMAL_OVERFLOW",
        message: "O resultado excede a precisão financeira suportada.",
        field,
      },
    ],
  };
}

function serializeBreakEvenUnits(
  value: BreakEvenResult,
  decimal: (number: number, scale?: number) => DecimalString,
): DecimalBreakEvenResult {
  if (value.status === "reachable") {
    return {
      status: "reachable",
      rawUnits: decimal(value.rawUnits, 6),
      roundedUnits: decimal(value.roundedUnits, 6),
      unitMode: value.unitMode,
    };
  }
  if (value.status === "unreachable") {
    return {
      status: "unreachable",
      rawUnits: null,
      roundedUnits: null,
      unitMode: value.unitMode,
      reason: value.reason,
    };
  }
  return {
    status: "invalid",
    rawUnits: null,
    roundedUnits: null,
    unitMode: value.unitMode,
    errors: value.errors,
  };
}

function resultSign(value: number): DecimalScenarioResult["resultSign"] {
  if (value > 0) return "positive";
  if (value < 0) return "negative";
  return "zero";
}

function recordFinancialState(state: "ok" | "incomplete" | "invalid"): void {
  applicationMetrics.financialStates.add(1, {
    state,
    engine_version: FINANCE_ENGINE_VERSION,
  });
}

export function runFinancialSimulation(
  input: SimulationServiceInput,
): CalculationResult<DecimalScenarioResult> {
  if (input.volumeSource === "real") {
    applicationMetrics.financialEngineVersion.add(1, { version: FINANCE_ENGINE_VERSION });
    recordFinancialState("invalid");
    return {
      status: "invalid",
      errors: [
        {
          code: "INVALID_VOLUME_SOURCE",
          message: "Volume real exige dados do domínio de vendas; use uma simulação explícita.",
          field: "volumeSource",
        },
      ],
    };
  }
  applicationMetrics.financialEngineVersion.add(1, { version: FINANCE_ENGINE_VERSION });
  const fees: FeeRow[] = input.fees.map((fee) => ({
    percentage: parseValue(fee.percentage),
  }));
  const result = calculateScenario({
    price: parseValue(input.price),
    unitCost: parseValue(input.unitCost),
    taxRate: parseValue(input.taxRate),
    fees,
    fixedExpenses: parseValue(input.fixedExpenses),
    volume: parseValue(input.volume),
    volumeSource: input.volumeSource,
  });
  if (result.status !== "ok") {
    recordFinancialState(result.status);
    return result;
  }

  const value = result.value;
  try {
    const decimal = (number: number, scale = 4): DecimalString => toDecimalString(number, scale);
    const breakEvenUnits = serializeBreakEvenUnits(value.breakEvenUnits, decimal);
    const output: CalculationResult<DecimalScenarioResult> = {
      status: "ok",
      value: {
        price: decimal(value.price),
        unitCost: decimal(value.unitCost),
        variableCost: decimal(value.variableCost),
        contributionMargin: decimal(value.contributionMargin),
        contributionMarginPct: decimal(value.contributionMarginPct, 6),
        breakEvenUnits,
        breakEvenRevenue: value.breakEvenRevenue == null ? null : decimal(value.breakEvenRevenue),
        volume: decimal(value.volume, 6),
        volumeSource: value.volumeSource,
        revenue: decimal(value.revenue),
        totalVariable: decimal(value.totalVariable),
        totalContribution: decimal(value.totalContribution),
        result: decimal(value.result),
        resultSign: resultSign(value.result),
      },
      warnings: result.warnings,
    };
    recordFinancialState("ok");
    return output;
  } catch (error) {
    if (error instanceof Error && error.message === "DECIMAL_OVERFLOW") {
      recordFinancialState("invalid");
      return serializationError("financialResult");
    }
    throw error;
  }
}
