/**
 * Cálculo puro de ponto de equilíbrio, importável por client e server.
 *
 * Fonte única da verdade: este módulo contém a implementação pura (Decimal +
 * @/lib/financial-values, sem dependência de servidor). O server fn
 * calculateBreakEven (break-even.functions.ts) executa a MESMA função
 * server-side via reexport em @/server/services/break-even.service, e a
 * exibição em /ponto-equilibrio calcula aqui (0 RT de exibição). Client e
 * server nunca divergem: paridade por construção.
 *
 * A persistência do calculation snapshot permanece server fn, com engine
 * version registrada server-side no snapshot (INV-015).
 */
import Decimal from "decimal.js";
import {
  FINANCIAL_DECIMAL_POLICY,
  decimalStringSchema,
  toDecimalString,
  type DecimalString,
} from "@/lib/financial-values";

export type BreakEvenServiceStatus = "reachable" | "unreachable" | "invalid";

export interface BreakEvenServiceInput {
  fixedExpenses: string[];
  price: string;
  contributionMargin: string;
  contributionMarginPct: string;
  desiredProfit: string | null;
  unitMode: "discrete" | "continuous";
}

export interface BreakEvenServiceError {
  code: "INVALID_DECIMAL" | "NON_POSITIVE_CONTRIBUTION" | "NON_FINITE_RESULT" | "DECIMAL_OVERFLOW";
  field: string;
  message: string;
}

export type BreakEvenUnits =
  | {
      status: "reachable";
      rawUnits: DecimalString;
      roundedUnits: DecimalString;
      unitMode: "discrete" | "continuous";
    }
  | {
      status: "unreachable";
      rawUnits: null;
      roundedUnits: null;
      unitMode: "discrete" | "continuous";
      reason: "NON_POSITIVE_CONTRIBUTION";
    }
  | {
      status: "invalid";
      rawUnits: null;
      roundedUnits: null;
      unitMode: "discrete" | "continuous";
      errors: BreakEvenServiceError[];
    };

export interface BreakEvenServiceResult {
  status: BreakEvenServiceStatus;
  fixedExpenses: DecimalString | null;
  units: BreakEvenUnits;
  revenue: DecimalString | null;
  targetUnits: BreakEvenUnits | null;
  targetRevenue: DecimalString | null;
}

/**
 * Domínio do decimal aceito na fronteira do motor. `non-negative` rejeita
 * qualquer valor negativo; `signed` o aceita — uma margem de contribuição
 * negativa (preço abaixo do custo variável) é um estado econômico legítimo,
 * que o motor classifica como não atingível, nunca como entrada inválida.
 */
type DecimalDomain = "non-negative" | "signed";

function parseDecimal(
  value: string,
  field: string,
  domain: DecimalDomain = "non-negative",
): Decimal {
  if (!decimalStringSchema.safeParse(value).success) throw invalidDecimal(field);
  let parsed: Decimal;
  try {
    parsed = new Decimal(value);
  } catch {
    throw invalidDecimal(field);
  }
  if (!parsed.isFinite() || (domain === "non-negative" && parsed.isNegative())) {
    throw invalidDecimal(field);
  }
  return parsed;
}

function invalidDecimal(field: string): BreakEvenServiceError {
  return {
    code: "INVALID_DECIMAL",
    field,
    message: "Informe um decimal finito dentro do intervalo permitido.",
  };
}

function serializationError(field: string, error: unknown): BreakEvenServiceError {
  return {
    code:
      error instanceof Error && error.message === "DECIMAL_OVERFLOW"
        ? "DECIMAL_OVERFLOW"
        : "NON_FINITE_RESULT",
    field,
    message:
      error instanceof Error && error.message === "DECIMAL_OVERFLOW"
        ? "O resultado excede a precisão financeira suportada."
        : "O cálculo não é finito.",
  };
}

function serviceError(error: unknown, field: string): BreakEvenServiceError {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    "message" in error &&
    "field" in error
  ) {
    return error as BreakEvenServiceError;
  }
  return serializationError(field, error);
}

function invalidUnits(
  unitMode: BreakEvenServiceInput["unitMode"],
  errors: BreakEvenServiceError[],
): BreakEvenUnits {
  return { status: "invalid", rawUnits: null, roundedUnits: null, unitMode, errors };
}

function calculateUnits(
  fixedExpenses: Decimal,
  contributionMargin: Decimal,
  unitMode: BreakEvenServiceInput["unitMode"],
): BreakEvenUnits {
  if (!contributionMargin.gt(0)) {
    return {
      status: "unreachable",
      rawUnits: null,
      roundedUnits: null,
      unitMode,
      reason: "NON_POSITIVE_CONTRIBUTION",
    };
  }

  const raw = fixedExpenses.div(contributionMargin);
  if (!raw.isFinite()) {
    return invalidUnits(unitMode, [
      { code: "NON_FINITE_RESULT", field: "rawUnits", message: "O cálculo não é finito." },
    ]);
  }

  const rounded = unitMode === "discrete" ? raw.ceil() : raw;
  try {
    return {
      status: "reachable",
      rawUnits: toDecimalString(raw, FINANCIAL_DECIMAL_POLICY.quantity.scale),
      roundedUnits: toDecimalString(rounded, FINANCIAL_DECIMAL_POLICY.quantity.scale),
      unitMode,
    };
  } catch (error) {
    return invalidUnits(unitMode, [serializationError("rawUnits", error)]);
  }
}

function invalidResult(
  input: BreakEvenServiceInput,
  errors: BreakEvenServiceError[],
): BreakEvenServiceResult {
  const units = invalidUnits(input.unitMode, errors);
  return {
    status: "invalid",
    fixedExpenses: null,
    units,
    revenue: null,
    targetUnits: null,
    targetRevenue: null,
  };
}

function sumFixedExpenses(values: string[]): {
  value: Decimal;
  errors: BreakEvenServiceError[];
} {
  const errors: BreakEvenServiceError[] = [];
  let value = new Decimal(0);
  for (const [index, expense] of values.entries()) {
    try {
      value = value.plus(parseDecimal(expense, `fixedExpenses[${index}]`));
    } catch (error) {
      errors.push(error as BreakEvenServiceError);
    }
  }
  return { value, errors };
}

function parseBaseInputs(
  input: BreakEvenServiceInput,
):
  | { price: Decimal; contributionMargin: Decimal; contributionMarginPct: Decimal }
  | { errors: BreakEvenServiceError[] } {
  try {
    return {
      price: parseDecimal(input.price, "price"),
      contributionMargin: parseDecimal(input.contributionMargin, "contributionMargin", "signed"),
      contributionMarginPct: parseDecimal(
        input.contributionMarginPct,
        "contributionMarginPct",
        "signed",
      ),
    };
  } catch (error) {
    return { errors: [error as BreakEvenServiceError] };
  }
}

function calculateRevenue(
  fixedExpenses: Decimal,
  contributionMarginPct: Decimal,
  units: BreakEvenUnits,
): { value: DecimalString | null; error: BreakEvenServiceError | null } {
  if (units.status === "unreachable" || !contributionMarginPct.gt(0)) {
    return { value: null, error: null };
  }
  try {
    return {
      value: toDecimalString(fixedExpenses.div(contributionMarginPct.div(100)), 4),
      error: null,
    };
  } catch (error) {
    return { value: null, error: serializationError("revenue", error) };
  }
}

function calculateTarget(
  input: BreakEvenServiceInput,
  fixedExpenses: Decimal,
  contributionMargin: Decimal,
  price: Decimal,
): { units: BreakEvenUnits | null; revenue: DecimalString | null } {
  if (input.desiredProfit == null || input.desiredProfit.trim() === "") {
    return { units: null, revenue: null };
  }
  try {
    const desiredProfit = parseDecimal(input.desiredProfit, "desiredProfit");
    const units = calculateUnits(
      fixedExpenses.plus(desiredProfit),
      contributionMargin,
      input.unitMode,
    );
    if (units.status !== "reachable") return { units, revenue: null };
    try {
      return {
        units,
        revenue: toDecimalString(new Decimal(units.roundedUnits).mul(price), 4),
      };
    } catch (error) {
      return {
        units: invalidUnits(input.unitMode, [serializationError("targetRevenue", error)]),
        revenue: null,
      };
    }
  } catch (error) {
    return {
      units: invalidUnits(input.unitMode, [serviceError(error, "desiredProfit")]),
      revenue: null,
    };
  }
}

function hasNonFiniteOutput(...values: Array<Decimal | DecimalString | null>): boolean {
  return values.some((value) => {
    if (value == null) return false;
    return (value instanceof Decimal ? value : new Decimal(value)).isFinite() === false;
  });
}

export function calculateBreakEvenSummary(input: BreakEvenServiceInput): BreakEvenServiceResult {
  const fixedExpensesResult = sumFixedExpenses(input.fixedExpenses);
  const baseInputs = parseBaseInputs(input);
  const baseErrors = "errors" in baseInputs ? baseInputs.errors : [];
  if ("errors" in baseInputs || fixedExpensesResult.errors.length) {
    return invalidResult(input, [...fixedExpensesResult.errors, ...baseErrors]);
  }
  const { value: fixedExpenses } = fixedExpensesResult;
  const { price, contributionMargin, contributionMarginPct } = baseInputs;

  const units = calculateUnits(fixedExpenses, contributionMargin, input.unitMode);
  if (units.status === "invalid") return invalidResult(input, units.errors);

  const revenueResult = calculateRevenue(fixedExpenses, contributionMarginPct, units);
  if (revenueResult.error) return invalidResult(input, [revenueResult.error]);
  const target = calculateTarget(input, fixedExpenses, contributionMargin, price);
  if (target.units?.status === "invalid") return invalidResult(input, target.units.errors);

  if (hasNonFiniteOutput(fixedExpenses, revenueResult.value, target.revenue))
    return invalidResult(input, [
      { code: "NON_FINITE_RESULT", field: "breakEven", message: "O cálculo não é finito." },
    ]);

  try {
    return {
      status: units.status,
      fixedExpenses: toDecimalString(fixedExpenses, FINANCIAL_DECIMAL_POLICY.money.scale),
      units,
      revenue: revenueResult.value,
      targetUnits: target.units,
      targetRevenue: target.revenue,
    };
  } catch (error) {
    return invalidResult(input, [serializationError("fixedExpenses", error)]);
  }
}
