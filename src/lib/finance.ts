/**
 * Motor financeiro determinístico.
 * Todos os cálculos do sistema passam por aqui — a IA NUNCA faz contas.
 */

import Decimal from "decimal.js";
import { quantityUnitDimension, type QuantityDimension } from "@/lib/financial-values";

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

function decimalResult(value: Decimal): number {
  if (!value.isFinite()) return Number.NaN;
  const result = value.toNumber();
  return Number.isFinite(result) ? result : Number.NaN;
}

/**
 * Contrato de resultado do motor (V7 §8.2 / Plano §6.2, FIN-001 — lote 03).
 * Separa cálculo válido (`ok`), dado incompleto (`incomplete`) e dado
 * inválido (`invalid`). O lote 04 introduziu `incomplete` para ausência e o
 * lote 05 introduziu `invalid` para números inválidos; a taxonomia definitiva
 * dos códigos de erro permanece no lote 10.
 */
export interface CalculationWarning {
  code: string;
  message: string;
  field?: string;
}

export interface MissingField {
  field: string;
  reason?: string;
}

export interface CalculationError {
  code: string;
  message: string;
  field?: string;
}

export type CalculationResult<T> =
  | { status: "ok"; value: T; warnings: CalculationWarning[] }
  | { status: "incomplete"; missing: MissingField[]; warnings: CalculationWarning[] }
  | { status: "invalid"; errors: CalculationError[] };

export function calcOk<T>(value: T, warnings: CalculationWarning[] = []): CalculationResult<T> {
  return { status: "ok", value, warnings };
}

export function calcIncomplete<T = never>(
  missing: MissingField[],
  warnings: CalculationWarning[] = [],
): CalculationResult<T> {
  return { status: "incomplete", missing, warnings };
}

export function calcInvalid<T = never>(errors: CalculationError[]): CalculationResult<T> {
  return { status: "invalid", errors };
}

interface NumericRules {
  min?: number;
  minExclusive?: number;
  max?: number;
}

function numericInputError(
  field: string,
  value: number,
  rules: NumericRules = {},
): CalculationError | null {
  if (!Number.isFinite(value)) {
    return {
      code: "INVALID_NUMBER",
      message: "Informe um número finito.",
      field,
    };
  }
  if (
    (rules.min !== undefined && value < rules.min) ||
    (rules.minExclusive !== undefined && value <= rules.minExclusive) ||
    (rules.max !== undefined && value > rules.max)
  ) {
    return {
      code: "INVALID_NUMBER",
      message: "Valor fora do intervalo permitido.",
      field,
    };
  }
  return null;
}

function collectNumericError(
  errors: CalculationError[],
  field: string,
  value: number,
  rules: NumericRules = {},
): void {
  const error = numericInputError(field, value, rules);
  if (error !== null) errors.push(error);
}

function collectNullableNumber(
  missing: MissingField[],
  errors: CalculationError[],
  field: string,
  value: number | null,
  rules: NumericRules = {},
): void {
  if (value == null) {
    missing.push({ field });
    return;
  }
  collectNumericError(errors, field, value, rules);
}

function nonFiniteResultError(field: string): CalculationError {
  return {
    code: "NON_FINITE_RESULT",
    message: "O cálculo produziu um resultado não finito.",
    field,
  };
}

/** Soma valores finitos sem deixar overflow ou entrada especial vazar. */
export function sumFiniteNumbers(values: number[]): number {
  let sum = new Decimal(0);
  for (const value of values) {
    if (!Number.isFinite(value)) return Number.NaN;
    sum = sum.plus(value);
    if (!sum.isFinite()) return Number.NaN;
  }
  return decimalResult(sum);
}

export type Unit =
  | "g"
  | "kg"
  | "mg"
  | "ml"
  | "l"
  | "unidade"
  | "un"
  | "dúzia"
  | "duzia"
  | "pacote"
  | "caixa"
  | "colher"
  | "xicara"
  | "xícara"
  | "lote"
  | "porção"
  | "porcao"
  | "receita"
  | "produção"
  | "producao"
  | "unidade_produzida";

const MASS: Record<string, number> = { mg: 0.001, g: 1, kg: 1000 };
const VOLUME: Record<string, number> = { ml: 1, l: 1000 };
const COUNT: Record<string, number> = { unidade: 1, un: 1, dúzia: 12, duzia: 12 };

function normUnit(u: string) {
  return (u || "").trim().toLowerCase();
}

export function unitDimension(unit: string): QuantityDimension | null {
  return quantityUnitDimension(unit);
}

export interface UnitConversionContext {
  fromUnit: string;
  toUnit: string;
  /** Quantidade na unidade de destino correspondente a 1 unidade de origem. */
  factor: number | string;
  contextId: string;
}

/**
 * Converte quantidade entre unidades da mesma família.
 * Retorna null quando as unidades não são convertíveis com segurança.
 */
export function convertUnit(
  qty: number,
  from: string,
  to: string,
  context?: UnitConversionContext,
): number | null {
  if (!Number.isFinite(qty)) return Number.NaN;
  const f = normUnit(from);
  const t = normUnit(to);
  if (unitDimension(f) === null || unitDimension(t) === null) return null;
  if (f === t) return qty;
  if (f in MASS && t in MASS) return decimalResult(new Decimal(qty).mul(MASS[f]).div(MASS[t]));
  if (f in VOLUME && t in VOLUME)
    return decimalResult(new Decimal(qty).mul(VOLUME[f]).div(VOLUME[t]));
  if (f in COUNT && t in COUNT) return decimalResult(new Decimal(qty).mul(COUNT[f]).div(COUNT[t]));
  if (context && normUnit(context.fromUnit) === f && normUnit(context.toUnit) === t) {
    try {
      const factor = new Decimal(context.factor);
      if (factor.isFinite() && factor.gt(0) && context.contextId.trim() !== "") {
        return decimalResult(new Decimal(qty).mul(factor));
      }
    } catch {
      return Number.NaN;
    }
  }
  return null;
}

export interface IngredientRow {
  used_qty: number;
  used_unit: string;
  package_price: number | null;
  package_qty: number | null;
  package_unit: string | null;
  conversion_context?: UnitConversionContext;
}

export function calculateIngredientCost(row: IngredientRow): number | null {
  // FIN-01: dado de embalagem desconhecido (null) não vira custo zero.
  // FIN-003: número inválido propaga NaN até o Result Type, nunca zero.
  if (numericInputError("used_qty", row.used_qty, { minExclusive: 0 })) return Number.NaN;
  if (
    row.package_price != null &&
    numericInputError("package_price", row.package_price, { min: 0 })
  )
    return Number.NaN;
  if (
    row.package_qty != null &&
    numericInputError("package_qty", row.package_qty, { minExclusive: 0 })
  )
    return Number.NaN;
  if (row.package_price == null || row.package_qty == null || row.package_unit == null) return null;
  const converted = convertUnit(
    row.used_qty,
    row.used_unit,
    row.package_unit,
    row.conversion_context,
  );
  // FIN-006: conversão incompatível ou contextual sem fator confirmado é desconhecida.
  if (converted === null) return null;
  return decimalResult(new Decimal(converted).mul(row.package_price).div(row.package_qty));
}

export function calculateRecipeCost(rows: IngredientRow[]): number | null {
  // Custo total é desconhecido se qualquer ingrediente for desconhecido.
  let sum = new Decimal(0);
  let incomplete = false;
  for (const r of rows) {
    const cost = calculateIngredientCost(r);
    if (cost === null) {
      incomplete = true;
      continue;
    }
    sum = sum.plus(cost);
    if (!sum.isFinite()) return Number.NaN;
  }
  return incomplete ? null : decimalResult(sum);
}

export interface PackagingRow {
  package_price: number;
  units_per_package: number;
}
export function calculatePackagingCost(rows: PackagingRow[]): number {
  let sum = new Decimal(0);
  for (const row of rows) {
    if (numericInputError("package_price", row.package_price, { min: 0 })) return Number.NaN;
    if (numericInputError("units_per_package", row.units_per_package, { minExclusive: 0 }))
      return Number.NaN;
    sum = sum.plus(new Decimal(row.package_price).div(row.units_per_package));
    if (!sum.isFinite()) return Number.NaN;
  }
  return decimalResult(sum);
}

export function calculateUnitCost(
  recipeCost: number | null,
  yieldQty: number | null,
  packagingCost: number | null,
): number | null {
  // FIN-02: custo/rendimento desconhecido não vira zero/um.
  if (recipeCost != null && numericInputError("recipeCost", recipeCost, { min: 0 }))
    return Number.NaN;
  if (packagingCost != null && numericInputError("packagingCost", packagingCost, { min: 0 }))
    return Number.NaN;
  if (yieldQty != null && numericInputError("yieldQty", yieldQty, { minExclusive: 0 }))
    return Number.NaN;
  if (recipeCost == null || packagingCost == null || yieldQty == null) return null;
  return decimalResult(new Decimal(recipeCost).div(yieldQty).plus(packagingCost));
}

export interface FeeRow {
  percentage: number | null;
}

/** SDD §11.7: imposto + taxas sobre preço bruto deve permanecer abaixo de 100%. */
function combinedRateError(taxRate: number | null, fees: FeeRow[]): CalculationError | null {
  let total = new Decimal(0);
  for (const value of [taxRate, ...fees.map((fee) => fee.percentage)]) {
    if (value == null) continue;
    if (numericInputError("rateOnGrossPrice", value, { min: 0, max: 100 })) return null;
    total = total.plus(value);
    if (!total.isFinite() || total.gte(100)) {
      return {
        code: "INVALID_NUMBER",
        message: "A soma de imposto e taxas deve ser menor que 100%.",
        field: "rateOnGrossPrice",
      };
    }
  }
  return null;
}

export function calculateVariableCost(
  price: number | null,
  taxRate: number | null,
  fees: FeeRow[],
): number | null {
  // FIN-03: preço/alíquota/taxa desconhecidos não viram zero.
  if (price != null && numericInputError("price", price, { min: 0 })) return Number.NaN;
  if (taxRate != null && numericInputError("taxRate", taxRate, { min: 0, max: 100 }))
    return Number.NaN;
  for (const fee of fees) {
    if (
      fee.percentage != null &&
      numericInputError("percentage", fee.percentage, { min: 0, max: 100 })
    )
      return Number.NaN;
  }
  if (combinedRateError(taxRate, fees)) return Number.NaN;
  if (price == null || taxRate == null || fees.some((fee) => fee.percentage == null)) return null;
  const totalRate = fees.reduce(
    (sum, fee) => sum.plus(fee.percentage as number),
    new Decimal(taxRate),
  );
  return decimalResult(new Decimal(price).mul(totalRate).div(100));
}

export function calculateContributionMargin(
  price: number,
  unitCost: number,
  variableCost: number,
): number {
  if (numericInputError("price", price, { min: 0 })) return Number.NaN;
  if (numericInputError("unitCost", unitCost, { min: 0 })) return Number.NaN;
  if (numericInputError("variableCost", variableCost, { min: 0 })) return Number.NaN;
  return decimalResult(new Decimal(price).minus(unitCost).minus(variableCost));
}

export function calculateContributionMarginPct(price: number, contributionMargin: number): number {
  if (numericInputError("price", price, { min: 0 })) return Number.NaN;
  if (numericInputError("contributionMargin", contributionMargin)) return Number.NaN;
  if (price === 0) return 0;
  return decimalResult(new Decimal(contributionMargin).div(price).mul(100));
}

export type BreakEvenUnitMode = "discrete" | "continuous";

export type BreakEvenResult =
  | {
      status: "reachable";
      rawUnits: number;
      roundedUnits: number;
      unitMode: BreakEvenUnitMode;
    }
  | {
      status: "unreachable";
      rawUnits: null;
      roundedUnits: null;
      unitMode: BreakEvenUnitMode;
      reason: "NON_POSITIVE_CONTRIBUTION";
    }
  | {
      status: "invalid";
      rawUnits: null;
      roundedUnits: null;
      unitMode: BreakEvenUnitMode;
      errors: CalculationError[];
    };

export function calculateBreakEvenUnits(
  fixedExpenses: number,
  cmUnit: number,
  unitMode: BreakEvenUnitMode = "discrete",
): BreakEvenResult {
  const errors = [
    numericInputError("fixedExpenses", fixedExpenses, { min: 0 }),
    numericInputError("cmUnit", cmUnit),
  ].filter((error): error is CalculationError => error !== null);
  if (unitMode !== "discrete" && unitMode !== "continuous") {
    errors.push({
      code: "INVALID_UNIT_MODE",
      message: "Informe um modo de unidade válido.",
      field: "unitMode",
    });
  }
  if (errors.length > 0) {
    return { status: "invalid", rawUnits: null, roundedUnits: null, unitMode, errors };
  }
  if (cmUnit <= 0) {
    return {
      status: "unreachable",
      rawUnits: null,
      roundedUnits: null,
      unitMode,
      reason: "NON_POSITIVE_CONTRIBUTION",
    };
  }
  const rawUnits = decimalResult(new Decimal(fixedExpenses).div(cmUnit));
  if (!Number.isFinite(rawUnits)) {
    return {
      status: "invalid",
      rawUnits: null,
      roundedUnits: null,
      unitMode,
      errors: [nonFiniteResultError("breakEvenUnits")],
    };
  }
  const roundedUnits = unitMode === "discrete" ? new Decimal(rawUnits).ceil().toNumber() : rawUnits;
  return { status: "reachable", rawUnits, roundedUnits, unitMode };
}

export function calculateBreakEvenRevenue(fixedExpenses: number, cmPct: number): number | null {
  if (numericInputError("fixedExpenses", fixedExpenses, { min: 0 })) return Number.NaN;
  if (numericInputError("cmPct", cmPct)) return Number.NaN;
  if (cmPct <= 0) return null;
  return decimalResult(new Decimal(fixedExpenses).div(new Decimal(cmPct).div(100)));
}

export function calculateRequiredSalesForProfit(
  fixedExpenses: number,
  desiredProfit: number,
  cmUnit: number,
  unitMode: BreakEvenUnitMode = "discrete",
): BreakEvenResult {
  const fixedExpensesError = numericInputError("fixedExpenses", fixedExpenses, { min: 0 });
  const desiredProfitError = numericInputError("desiredProfit", desiredProfit, { min: 0 });
  const cmUnitError = numericInputError("cmUnit", cmUnit);
  const inputErrors = [fixedExpensesError, desiredProfitError, cmUnitError].filter(
    (error): error is CalculationError => error !== null,
  );
  if (unitMode !== "discrete" && unitMode !== "continuous") {
    inputErrors.push({
      code: "INVALID_UNIT_MODE",
      message: "Informe um modo de unidade válido.",
      field: "unitMode",
    });
  }
  if (inputErrors.length > 0) {
    return {
      status: "invalid",
      rawUnits: null,
      roundedUnits: null,
      unitMode,
      errors: inputErrors,
    };
  }
  const requiredContribution = decimalResult(new Decimal(fixedExpenses).plus(desiredProfit));
  if (!Number.isFinite(requiredContribution)) {
    return {
      status: "invalid",
      rawUnits: null,
      roundedUnits: null,
      unitMode,
      errors: [nonFiniteResultError("requiredContribution")],
    };
  }
  return calculateBreakEvenUnits(requiredContribution, cmUnit, unitMode);
}

export type VolumeSource = "real" | "manual_simulation" | "forecast" | "unknown";

export type ResolvedVolumeSource = Exclude<VolumeSource, "unknown">;

/**
 * Volume real é requisito necessário, mas não suficiente, para um KPI factual.
 * Preço hipotético × volume real continua sendo uma simulação; faturamento
 * realizado deve vir do futuro domínio de vendas.
 */
export function isFactualVolumeSource(source: VolumeSource): source is "real" {
  return source === "real";
}

export interface ScenarioInput {
  price: number | null;
  unitCost: number | null;
  taxRate: number | null;
  fees: FeeRow[];
  fixedExpenses: number | null;
  volume: number | null;
  volumeSource: VolumeSource;
}

export interface ScenarioResult {
  price: number;
  unitCost: number;
  variableCost: number;
  contributionMargin: number;
  contributionMarginPct: number;
  breakEvenUnits: BreakEvenResult;
  breakEvenRevenue: number | null;
  volume: number;
  volumeSource: ResolvedVolumeSource;
  revenue: number;
  totalVariable: number;
  totalContribution: number;
  result: number; // resultado operacional no escopo informado
}

const VOLUME_SOURCES: readonly VolumeSource[] = [
  "real",
  "manual_simulation",
  "forecast",
  "unknown",
];

function invalidVolumeSourceError(message: string): CalculationError {
  return {
    code: "INVALID_VOLUME_SOURCE",
    message,
    field: "volumeSource",
  };
}

/** Campos de taxas ausentes, indexados para a UI apontar a origem. */
function missingFeeFields(fees: FeeRow[]): MissingField[] {
  const missing: MissingField[] = [];
  fees.forEach((f, i) => {
    if (f.percentage == null) missing.push({ field: `fees[${i}].percentage` });
  });
  return missing;
}

function invalidFeeErrors(fees: FeeRow[]): CalculationError[] {
  const errors: CalculationError[] = [];
  fees.forEach((fee, i) => {
    if (fee.percentage != null) {
      collectNumericError(errors, `fees[${i}].percentage`, fee.percentage, { min: 0, max: 100 });
    }
  });
  return errors;
}

export interface PriceFormationInput {
  directUnitCost: number | null;
  nonPercentageVariableUnitCost: number | null;
  taxRate: number | null;
  fees: FeeRow[];
  targetContributionRate: number | null;
  marketReference: number | null;
}

export interface PriceFormationResult {
  minimumSustainablePrice: CalculationResult<number>;
  targetMarginPrice: CalculationResult<number>;
  marketReference: CalculationResult<number>;
}

function calculatePriceForContributionRate(
  input: Omit<PriceFormationInput, "marketReference" | "targetContributionRate">,
  targetContributionRate: number | null,
): CalculationResult<number> {
  const missing: MissingField[] = [];
  const errors: CalculationError[] = [];
  collectNullableNumber(missing, errors, "directUnitCost", input.directUnitCost, { min: 0 });
  collectNullableNumber(
    missing,
    errors,
    "nonPercentageVariableUnitCost",
    input.nonPercentageVariableUnitCost,
    { min: 0 },
  );
  collectNullableNumber(missing, errors, "taxRate", input.taxRate, { min: 0, max: 100 });
  missing.push(...missingFeeFields(input.fees));
  errors.push(...invalidFeeErrors(input.fees));
  const rateError = combinedRateError(input.taxRate, input.fees);
  if (rateError !== null) errors.push(rateError);
  collectNullableNumber(missing, errors, "targetContributionRate", targetContributionRate, {
    min: 0,
    max: 100,
  });
  if (errors.length > 0) return calcInvalid(errors);
  if (missing.length > 0) return calcIncomplete(missing);

  const percentageRate = sumFiniteNumbers([
    input.taxRate as number,
    ...input.fees.map((fee) => fee.percentage as number),
  ]);
  if (!Number.isFinite(percentageRate))
    return calcInvalid([nonFiniteResultError("rateOnGrossPrice")]);

  const denominator = decimalResult(
    new Decimal(1).minus(
      new Decimal(percentageRate).plus(targetContributionRate as number).div(100),
    ),
  );
  if (!Number.isFinite(denominator))
    return calcInvalid([nonFiniteResultError("priceFormationDenominator")]);
  if (denominator <= 0) {
    return calcInvalid([
      {
        code: "INVALID_NUMBER",
        message: "A soma das incidências e da margem alvo deve ser menor que 100%.",
        field: "targetContributionRate",
      },
    ]);
  }

  const modeledUnitCost = sumFiniteNumbers([
    input.directUnitCost as number,
    input.nonPercentageVariableUnitCost as number,
  ]);
  if (!Number.isFinite(modeledUnitCost))
    return calcInvalid([nonFiniteResultError("modeledUnitCost")]);
  const price = decimalResult(new Decimal(modeledUnitCost).div(denominator));
  if (!Number.isFinite(price)) return calcInvalid([nonFiniteResultError("price")]);
  return calcOk(price);
}

function validateMarketReference(value: number | null): CalculationResult<number> {
  const missing: MissingField[] = [];
  const errors: CalculationError[] = [];
  collectNullableNumber(missing, errors, "marketReference", value, { min: 0 });
  if (errors.length > 0) return calcInvalid(errors);
  if (missing.length > 0) return calcIncomplete(missing);
  return calcOk(value as number);
}

/**
 * SDD §11.12, Modelo A. Cada saída mantém status independente: margem alvo
 * ausente não oculta o mínimo calculável nem a referência externa informada.
 */
export function calculatePriceFormation(input: PriceFormationInput): PriceFormationResult {
  const base = {
    directUnitCost: input.directUnitCost,
    nonPercentageVariableUnitCost: input.nonPercentageVariableUnitCost,
    taxRate: input.taxRate,
    fees: input.fees,
  };
  return {
    minimumSustainablePrice: calculatePriceForContributionRate(base, 0),
    targetMarginPrice: calculatePriceForContributionRate(base, input.targetContributionRate),
    marketReference: validateMarketReference(input.marketReference),
  };
}

export function calculateScenario(i: ScenarioInput): CalculationResult<ScenarioResult> {
  const missing: MissingField[] = [];
  const errors: CalculationError[] = [];
  collectNullableNumber(missing, errors, "price", i.price, { min: 0 });
  collectNullableNumber(missing, errors, "unitCost", i.unitCost, { min: 0 });
  collectNullableNumber(missing, errors, "taxRate", i.taxRate, { min: 0, max: 100 });
  missing.push(...missingFeeFields(i.fees));
  errors.push(...invalidFeeErrors(i.fees));
  const rateError = combinedRateError(i.taxRate, i.fees);
  if (rateError !== null) errors.push(rateError);
  collectNullableNumber(missing, errors, "fixedExpenses", i.fixedExpenses, { min: 0 });
  collectNullableNumber(missing, errors, "volume", i.volume, { min: 0 });
  if (!VOLUME_SOURCES.includes(i.volumeSource)) {
    errors.push(invalidVolumeSourceError("Informe uma origem de volume válida."));
  } else if (i.volumeSource === "unknown" && i.volume !== null) {
    errors.push(invalidVolumeSourceError("Volume numérico não pode ter origem desconhecida."));
  }
  if (errors.length > 0) return calcInvalid(errors);
  if (missing.length > 0) return calcIncomplete(missing);

  const price = i.price as number;
  const unitCost = i.unitCost as number;
  const taxRate = i.taxRate as number;
  const fixedExpenses = i.fixedExpenses as number;
  const volume = i.volume as number;
  const volumeSource = i.volumeSource as ResolvedVolumeSource;
  const variableCost = calculateVariableCost(price, taxRate, i.fees);
  if (variableCost == null || !Number.isFinite(variableCost))
    return calcInvalid([nonFiniteResultError("variableCost")]);
  const contributionMargin = calculateContributionMargin(price, unitCost, variableCost);
  if (!Number.isFinite(contributionMargin))
    return calcInvalid([nonFiniteResultError("contributionMargin")]);
  const contributionMarginPct = calculateContributionMarginPct(price, contributionMargin);
  if (!Number.isFinite(contributionMarginPct))
    return calcInvalid([nonFiniteResultError("contributionMarginPct")]);
  const breakEvenUnits = calculateBreakEvenUnits(fixedExpenses, contributionMargin);
  if (breakEvenUnits.status === "invalid") return calcInvalid(breakEvenUnits.errors);
  const breakEvenRevenue = calculateBreakEvenRevenue(fixedExpenses, contributionMarginPct);
  if (breakEvenRevenue != null && !Number.isFinite(breakEvenRevenue))
    return calcInvalid([nonFiniteResultError("breakEvenRevenue")]);

  const finiteOutputs = {
    revenue: decimalResult(new Decimal(price).mul(volume)),
    totalVariable: decimalResult(new Decimal(unitCost).plus(variableCost).mul(volume)),
    totalContribution: decimalResult(new Decimal(contributionMargin).mul(volume)),
  };
  const invalidOutput = Object.entries(finiteOutputs).find(([, value]) => !Number.isFinite(value));
  if (invalidOutput) return calcInvalid([nonFiniteResultError(invalidOutput[0])]);
  const result = decimalResult(new Decimal(finiteOutputs.totalContribution).minus(fixedExpenses));
  if (!Number.isFinite(result)) return calcInvalid([nonFiniteResultError("result")]);

  return calcOk({
    price,
    unitCost,
    variableCost,
    contributionMargin,
    contributionMarginPct,
    breakEvenUnits,
    breakEvenRevenue,
    volume,
    volumeSource,
    ...finiteOutputs,
    result,
  });
}

export interface ProductCostInput {
  ingredients: IngredientRow[];
  packaging: PackagingRow[];
  yieldQty: number | null;
}

export interface ProductCostComputation {
  recipeCost: number;
  packagingCost: number;
  unitCost: number;
}

export interface ProductInput extends ProductCostInput {
  price: number | null;
  taxRate: number | null;
  fees: FeeRow[];
}

export interface ProductComputation extends ProductCostComputation {
  variableCost: number;
  contributionMargin: number;
  contributionMarginPct: number;
}

function collectProductCostIssues(
  args: ProductCostInput,
  missing: MissingField[],
  errors: CalculationError[],
): void {
  args.ingredients.forEach((row, i) => {
    collectNumericError(errors, `ingredients[${i}].used_qty`, row.used_qty, { minExclusive: 0 });
    collectNullableNumber(missing, errors, `ingredients[${i}].package_price`, row.package_price, {
      min: 0,
    });
    collectNullableNumber(missing, errors, `ingredients[${i}].package_qty`, row.package_qty, {
      minExclusive: 0,
    });
    const usedDimension = unitDimension(row.used_unit);
    if (usedDimension === null) {
      errors.push({
        code: "UNSUPPORTED_UNIT",
        message: "Informe uma unidade de uso suportada.",
        field: `ingredients[${i}].used_unit`,
      });
    }
    if (row.package_unit == null) {
      missing.push({ field: `ingredients[${i}].package_unit` });
      return;
    }
    const packageDimension = unitDimension(row.package_unit);
    if (packageDimension === null) {
      errors.push({
        code: "UNSUPPORTED_UNIT",
        message: "Informe uma unidade de embalagem suportada.",
        field: `ingredients[${i}].package_unit`,
      });
      return;
    }
    if (
      Number.isFinite(row.used_qty) &&
      convertUnit(row.used_qty, row.used_unit, row.package_unit, row.conversion_context) === null
    ) {
      missing.push({
        field: `ingredients[${i}].conversion_context`,
        reason:
          usedDimension === packageDimension
            ? "Confirme o fator de conversão comercial."
            : "A conversão entre dimensões exige um fator contextual confirmado.",
      });
    }
  });
  args.packaging.forEach((row, i) => {
    collectNumericError(errors, `packaging[${i}].package_price`, row.package_price, { min: 0 });
    collectNumericError(errors, `packaging[${i}].units_per_package`, row.units_per_package, {
      minExclusive: 0,
    });
  });
}

function calculateProductCostOutputs(
  args: ProductCostInput,
): CalculationResult<ProductCostComputation> {
  const recipeCost = calculateRecipeCost(args.ingredients);
  if (recipeCost == null || !Number.isFinite(recipeCost))
    return calcInvalid([nonFiniteResultError("recipeCost")]);
  const packagingCost = calculatePackagingCost(args.packaging);
  if (!Number.isFinite(packagingCost)) return calcInvalid([nonFiniteResultError("packagingCost")]);
  const unitCost = calculateUnitCost(recipeCost, args.yieldQty as number, packagingCost);
  if (unitCost == null || !Number.isFinite(unitCost))
    return calcInvalid([nonFiniteResultError("unitCost")]);
  return calcOk({ recipeCost, packagingCost, unitCost });
}

/** Custo direto independente do preço de venda atual (FIN-005 — lote 07). */
export function computeProductCost(
  args: ProductCostInput,
): CalculationResult<ProductCostComputation> {
  const missing: MissingField[] = [];
  const errors: CalculationError[] = [];
  collectProductCostIssues(args, missing, errors);
  collectNullableNumber(missing, errors, "yieldQty", args.yieldQty, { minExclusive: 0 });
  if (errors.length > 0) return calcInvalid(errors);
  if (missing.length > 0) return calcIncomplete(missing);
  return calculateProductCostOutputs(args);
}

export function computeProduct(args: ProductInput): CalculationResult<ProductComputation> {
  // FIN-002/003: ausência vira incomplete; número inválido vira invalid.
  const missing: MissingField[] = [];
  const errors: CalculationError[] = [];
  collectProductCostIssues(args, missing, errors);
  missing.push(...missingFeeFields(args.fees));
  errors.push(...invalidFeeErrors(args.fees));
  const rateError = combinedRateError(args.taxRate, args.fees);
  if (rateError !== null) errors.push(rateError);
  collectNullableNumber(missing, errors, "yieldQty", args.yieldQty, { minExclusive: 0 });
  collectNullableNumber(missing, errors, "price", args.price, { min: 0 });
  collectNullableNumber(missing, errors, "taxRate", args.taxRate, { min: 0, max: 100 });
  if (errors.length > 0) return calcInvalid(errors);
  if (missing.length > 0) return calcIncomplete(missing);

  const costs = calculateProductCostOutputs(args);
  if (costs.status === "invalid") return calcInvalid(costs.errors);
  if (costs.status === "incomplete") return calcIncomplete(costs.missing, costs.warnings);

  const price = args.price as number;
  const taxRate = args.taxRate as number;
  const variableCost = calculateVariableCost(price, taxRate, args.fees);
  if (variableCost == null || !Number.isFinite(variableCost))
    return calcInvalid([nonFiniteResultError("variableCost")]);
  const contributionMargin = calculateContributionMargin(price, costs.value.unitCost, variableCost);
  if (!Number.isFinite(contributionMargin))
    return calcInvalid([nonFiniteResultError("contributionMargin")]);
  const contributionMarginPct = calculateContributionMarginPct(price, contributionMargin);
  if (!Number.isFinite(contributionMarginPct))
    return calcInvalid([nonFiniteResultError("contributionMarginPct")]);
  return calcOk({
    ...costs.value,
    variableCost,
    contributionMargin,
    contributionMarginPct,
  });
}
