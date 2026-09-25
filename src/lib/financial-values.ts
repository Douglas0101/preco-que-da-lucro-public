import Decimal from "decimal.js";
import { z } from "zod";

/**
 * Representação canônica nas fronteiras HTTP/DB. O branding impede que uma
 * string de apresentação (por exemplo, "R$ 1,00") entre no motor financeiro.
 */
export type DecimalString = string & { readonly __decimalString: unique symbol };

export type Money = Readonly<{
  amount: DecimalString;
  currency: "BRL";
}>;

/** Percentual canônico em fração: 0.15 representa 15%. */
export type Percent = Readonly<{
  value: DecimalString;
}>;

export type QuantityDimension = "mass" | "volume" | "count" | "production" | "commercial";

export const QUANTITY_UNITS = [
  "g",
  "kg",
  "mg",
  "ml",
  "l",
  "unidade",
  "un",
  "dúzia",
  "duzia",
  "pacote",
  "caixa",
  "colher",
  "xicara",
  "xícara",
  "lote",
  "porção",
  "porcao",
  "receita",
  "produção",
  "producao",
  "unidade_produzida",
] as const;

export type QuantityUnit = (typeof QUANTITY_UNITS)[number];

export type Quantity = Readonly<{
  amount: DecimalString;
  unit: QuantityUnit;
  dimension: QuantityDimension;
  conversionContextId?: string;
}>;

const decimalPattern = /^-?(?:0|[1-9]\d*)(?:\.\d+)?$/;

function policyForScale(scale: number) {
  if (scale === FINANCIAL_DECIMAL_POLICY.money.scale) return FINANCIAL_DECIMAL_POLICY.money;
  if (scale === FINANCIAL_DECIMAL_POLICY.percent.scale) return FINANCIAL_DECIMAL_POLICY.quantity;
  if (scale === FINANCIAL_DECIMAL_POLICY.intermediate.scale)
    return FINANCIAL_DECIMAL_POLICY.intermediate;
  return { precision: FINANCIAL_DECIMAL_POLICY.intermediate.precision, scale };
}

function fitsPolicy(value: Decimal, precision: number, scale: number): boolean {
  const integerDigits = precision - scale;
  if (integerDigits < 1) return false;

  // Avoid materializing an unbounded fixed-point string for an exponent that
  // cannot fit in the target NUMERIC precision in the first place.
  const maximum = new Decimal(10).pow(integerDigits);
  if (value.abs().gte(maximum)) return false;

  const rounded = value.toDecimalPlaces(scale, Decimal.ROUND_HALF_UP);
  if (!rounded.isFinite()) return false;
  const [integerPart] = rounded.toFixed(scale).replace("-", "").split(".");
  const significantIntegerDigits = integerPart.replace(/^0+/, "").length || 1;
  return significantIntegerDigits <= integerDigits;
}

function isFiniteDecimal(value: string): boolean {
  try {
    return new Decimal(value).isFinite();
  } catch {
    return false;
  }
}

export const decimalStringSchema = z
  .string()
  .regex(decimalPattern, "Use uma string decimal canônica.")
  .refine(isFiniteDecimal, "O decimal deve ser finito.")
  .transform((value) => value as DecimalString);

export const nonNegativeDecimalStringSchema = decimalStringSchema.refine(
  (value) => new Decimal(value).gte(0),
  "O decimal não pode ser negativo.",
);

export const positiveDecimalStringSchema = decimalStringSchema.refine(
  (value) => new Decimal(value).gt(0),
  "O decimal deve ser positivo.",
);

export const percentFractionSchema = nonNegativeDecimalStringSchema.refine(
  (value) => new Decimal(value).lt(1),
  "O percentual deve ser uma fração entre 0 e 1.",
);

export const moneySchema = z.object({
  amount: decimalStringSchema,
  currency: z.literal("BRL"),
});

export const percentSchema = z.object({
  value: decimalStringSchema.refine(
    (value) => new Decimal(value).gte(0) && new Decimal(value).lte(1),
    "O percentual deve estar entre 0 e 1.",
  ),
});

export const quantityUnitSchema = z.string().trim().toLowerCase().pipe(z.enum(QUANTITY_UNITS));

const QUANTITY_UNIT_DIMENSIONS: Record<QuantityUnit, QuantityDimension> = {
  g: "mass",
  kg: "mass",
  mg: "mass",
  ml: "volume",
  l: "volume",
  unidade: "count",
  un: "count",
  dúzia: "count",
  duzia: "count",
  pacote: "commercial",
  caixa: "commercial",
  colher: "commercial",
  xicara: "commercial",
  xícara: "commercial",
  lote: "production",
  porção: "production",
  porcao: "production",
  receita: "production",
  produção: "production",
  producao: "production",
  unidade_produzida: "production",
};

export function quantityUnitDimension(unit: string): QuantityDimension | null {
  const normalized = unit.trim().toLowerCase();
  return normalized in QUANTITY_UNIT_DIMENSIONS
    ? QUANTITY_UNIT_DIMENSIONS[normalized as QuantityUnit]
    : null;
}

export const quantitySchema = z
  .object({
    amount: decimalStringSchema.refine(
      (value) => new Decimal(value).gt(0),
      "Informe uma quantidade positiva.",
    ),
    unit: quantityUnitSchema,
    dimension: z.enum(["mass", "volume", "count", "production", "commercial"]),
    conversionContextId: z.string().trim().min(1).optional(),
  })
  .superRefine((value, ctx) => {
    if (quantityUnitDimension(value.unit) !== value.dimension) {
      ctx.addIssue({
        code: "custom",
        path: ["dimension"],
        message: "A dimensão não corresponde à unidade informada.",
      });
    }
  });

export const FINANCIAL_DECIMAL_POLICY = Object.freeze({
  money: { precision: 19, scale: 4 },
  intermediate: { precision: 24, scale: 8 },
  percent: { precision: 9, scale: 6 },
  quantity: { precision: 24, scale: 6 },
  rounding: "ROUND_HALF_UP" as const,
});

Decimal.set({ precision: 40, rounding: Decimal.ROUND_HALF_UP });

export function toDecimalString(value: Decimal.Value, scale?: number): DecimalString {
  const decimal = new Decimal(value);
  if (!decimal.isFinite()) throw new Error("NON_FINITE_DECIMAL");

  if (scale !== undefined) {
    if (!Number.isInteger(scale) || scale < 0) throw new Error("INVALID_DECIMAL_SCALE");
    const policy = policyForScale(scale);
    if (!fitsPolicy(decimal, policy.precision, policy.scale)) {
      throw new Error("DECIMAL_OVERFLOW");
    }
  } else {
    // A scale-less value is still a financial decimal. Keep it bounded by the
    // intermediate domain while preserving its exact fractional representation.
    const maximum = new Decimal(10).pow(FINANCIAL_DECIMAL_POLICY.intermediate.precision);
    const minimum = new Decimal(10).pow(-FINANCIAL_DECIMAL_POLICY.intermediate.scale);
    if (decimal.abs().gte(maximum) || (!decimal.isZero() && decimal.abs().lt(minimum))) {
      throw new Error("DECIMAL_OVERFLOW");
    }
  }

  const result = scale === undefined ? decimal.toFixed() : decimal.toFixed(scale);
  if (!decimalPattern.test(result)) throw new Error("NON_CANONICAL_DECIMAL");
  return result as DecimalString;
}

export function percentPointsToFraction(value: Decimal.Value): Percent {
  return {
    value: toDecimalString(new Decimal(value).div(100), FINANCIAL_DECIMAL_POLICY.percent.scale),
  };
}

export function fractionToPercentPoints(value: Percent): Decimal {
  return new Decimal(value.value).mul(100);
}
