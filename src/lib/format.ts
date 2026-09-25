import Decimal from "decimal.js";

export type NumericDisplayState = "ok" | "incomplete" | "invalid" | "infinite";
export type NumericDisplayValue = number | string | null | undefined;

function displayNumber(v: NumericDisplayValue): number | null {
  if (v == null) return null;
  try {
    const decimal = new Decimal(v);
    if (!decimal.isFinite()) {
      if (decimal.isPositive()) return Infinity;
      return Number.NaN;
    }
    const value = decimal.toNumber();
    if (Number.isFinite(value)) return value;
    if (value > 0) return Infinity;
    return Number.NaN;
  } catch {
    return Number.NaN;
  }
}

/** Classifica valores para apresentação financeira (V7 §8.3 / FIN-003). */
export function numericDisplayState(v: NumericDisplayValue): NumericDisplayState {
  if (v == null) return "incomplete";
  const value = displayNumber(v);
  if (value == null || Number.isNaN(value) || value === Number.NEGATIVE_INFINITY) return "invalid";
  if (value === Number.POSITIVE_INFINITY) return "infinite";
  return "ok";
}

function displayFallback(v: NumericDisplayValue): string | null {
  switch (numericDisplayState(v)) {
    case "incomplete":
      return "—";
    case "invalid":
      return "Erro de cálculo";
    case "infinite":
      return "Não atingível";
    case "ok":
      return null;
  }
}

export const brl = (v: NumericDisplayValue) => {
  const fallback = displayFallback(v);
  if (fallback !== null) return fallback;
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(
    displayNumber(v) as number,
  );
};

export const pct = (v: NumericDisplayValue, digits = 2) => {
  const fallback = displayFallback(v);
  if (fallback !== null) return fallback;
  return `${(displayNumber(v) as number).toLocaleString("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  })}%`;
};

export const num = (v: NumericDisplayValue, digits = 2) => {
  const fallback = displayFallback(v);
  if (fallback !== null) return fallback;
  return (displayNumber(v) as number).toLocaleString("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
};

const DECIMAL_INPUT_MAX_DIGITS = 6;

/**
 * Semeia draft de input com vírgula pt-BR (NUMERIC cru "20.0000" → "20,00").
 * Valores além da escala suportada são rejeitados para evitar perda silenciosa.
 */
export const decimalInput = (v: NumericDisplayValue, minDigits = 2): string => {
  if (v == null) return "";
  let decimal: Decimal;
  try {
    decimal = new Decimal(v);
  } catch {
    return "";
  }
  if (!decimal.isFinite()) return "";
  const requestedDigits = Math.trunc(minDigits);
  if (
    requestedDigits < 0 ||
    requestedDigits > DECIMAL_INPUT_MAX_DIGITS ||
    decimal.dp() > DECIMAL_INPUT_MAX_DIGITS
  ) {
    return "";
  }
  const digits = Math.max(requestedDigits, decimal.dp());
  return decimal.toFixed(digits).replace(".", ",");
};

/** Quantidade sem zeros à direita ("0.5" → "0,5", "6.000000" → "6"), com unidade opcional. */
export const qty = (v: NumericDisplayValue, unit?: string | null, digits = 6): string => {
  const fallback = displayFallback(v);
  if (fallback !== null) return fallback;
  let text = new Decimal(v as string | number).toFixed(Math.max(0, digits));
  if (text.includes(".")) {
    text = text.replace(/0+$/, "").replace(/\.$/, "");
  }
  text = text.replace(".", ",");
  return unit ? `${text} ${unit}` : text;
};
