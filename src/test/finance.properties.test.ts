import fc from "fast-check";
import Decimal from "decimal.js";
import { describe, expect, it } from "vitest";
import {
  calculateBreakEvenUnits,
  calculateContributionMargin,
  calculatePriceFormation,
  calculateScenario,
  calculateVariableCost,
  sumFiniteNumbers,
  type FeeRow,
  type ScenarioInput,
} from "@/lib/finance";
import { toDecimalString } from "@/lib/financial-values";

/** Gera taxas percentuais válidas e soma total estritamente abaixo de 100. */
function validRatesArbitrary() {
  return fc
    .tuple(
      fc.double({ min: 0, max: 40, noNaN: true }),
      fc.array(fc.double({ min: 0, max: 20, noNaN: true }), { maxLength: 3 }),
      fc.double({ min: 0, max: 30, noNaN: true }),
    )
    .filter(([taxRate, fees, target]) => taxRate + fees.reduce((a, b) => a + b, 0) + target < 100)
    .map(([taxRate, fees, target]) => ({
      taxRate,
      fees: fees.map((percentage) => ({ percentage })) satisfies FeeRow[],
      target,
    }));
}

const nonNegativeMoney = fc.double({ min: 0, max: 10_000, noNaN: true });

/**
 * Cenário válido do motor (`calculateScenario`): preço > 0, custo e despesas
 * fixas ≥ 0, volume ≥ 0 com origem de volume informada
 * (`manual_simulation`/`forecast`) e imposto + taxas somando < 100%.
 * Compartilhado pelas propriedades P1 (custo↑) e P3 (volume↑) para que ambas
 * exercitem o mesmo domínio do motor, sem re-derivar aritmética no teste.
 */
interface ScenarioRates {
  taxRate: number;
  fees: FeeRow[];
}

interface ScenarioParts {
  price: number;
  unitCost: number;
  fixedExpenses: number;
  volume: number;
  volumeSource: "manual_simulation" | "forecast";
  rates: ScenarioRates;
}

const validScenarioArbitrary = fc.record({
  price: fc.double({ min: 0.01, max: 5_000, noNaN: true }),
  unitCost: nonNegativeMoney,
  fixedExpenses: nonNegativeMoney,
  volume: fc.double({ min: 0.01, max: 1_000_000, noNaN: true }),
  volumeSource: fc.constantFrom("manual_simulation" as const, "forecast" as const),
  rates: validRatesArbitrary(),
});

/** Monta a entrada de `calculateScenario` a partir das partes geradas. */
function scenarioInput(
  parts: ScenarioParts,
  overrides: Partial<Pick<ScenarioInput, "price" | "unitCost" | "fixedExpenses" | "volume">> = {},
): ScenarioInput {
  return {
    price: parts.price,
    unitCost: parts.unitCost,
    taxRate: parts.rates.taxRate,
    fees: parts.rates.fees,
    fixedExpenses: parts.fixedExpenses,
    volume: parts.volume,
    volumeSource: parts.volumeSource,
    ...overrides,
  };
}

describe("propriedades do motor financeiro (fast-check)", () => {
  it("preço mínimo é finito, não negativo e cobre o custo modelado", () => {
    const input = fc.tuple(nonNegativeMoney, nonNegativeMoney, validRatesArbitrary());
    const property = fc.property(input, ([directUnitCost, otherVariable, rates]) => {
      const result = calculatePriceFormation({
        directUnitCost,
        nonPercentageVariableUnitCost: otherVariable,
        taxRate: rates.taxRate,
        fees: rates.fees,
        targetContributionRate: null,
        marketReference: null,
      });
      expect(result.minimumSustainablePrice.status).toBe("ok");
      if (result.minimumSustainablePrice.status !== "ok") return;
      const price = result.minimumSustainablePrice.value;
      expect(Number.isFinite(price)).toBe(true);
      expect(price).toBeGreaterThanOrEqual(0);
      expect(price).toBeGreaterThanOrEqual(directUnitCost + otherVariable - 1e-6);
    });
    fc.assert(property);
  });

  it("preço formado cresce (não decresce) com a margem alvo", () => {
    const input = fc
      .tuple(nonNegativeMoney, nonNegativeMoney, validRatesArbitrary())
      .filter(([, , rates]) => {
        // O denominador do motor (src/lib/finance.ts) exige
        // taxRate + Σfees + margem < 100; o filtro precisa cobrir a margem
        // MAIOR (target + 25) — a versão anterior ignorava Σfees e deixava
        // o gerador produzir margens inválidas (flake em CI).
        const feesTotal = rates.fees.reduce((sum, fee) => sum + (fee.percentage ?? 0), 0);
        return rates.taxRate + feesTotal + rates.target + 25 < 99.999999999;
      });
    const property = fc.property(input, ([directUnitCost, otherVariable, rates]) => {
      const base = {
        directUnitCost,
        nonPercentageVariableUnitCost: otherVariable,
        taxRate: rates.taxRate,
        fees: rates.fees,
        marketReference: null,
      };
      const lower = calculatePriceFormation({
        ...base,
        targetContributionRate: rates.target,
      }).targetMarginPrice;
      const higher = calculatePriceFormation({
        ...base,
        targetContributionRate: rates.target + 25,
      }).targetMarginPrice;
      expect(lower.status).toBe("ok");
      expect(higher.status).toBe("ok");
      if (lower.status !== "ok" || higher.status !== "ok") return;
      expect(higher.value).toBeGreaterThanOrEqual(lower.value - 1e-6);
    });
    fc.assert(property);
  });

  it("margem de contribuição obedece à identidade e cresce com o preço", () => {
    const property = fc.property(
      fc.tuple(
        fc.double({ min: 0.01, max: 5_000, noNaN: true }),
        nonNegativeMoney,
        validRatesArbitrary(),
      ),
      ([price, unitCost, rates]) => {
        const variableCost = calculateVariableCost(price, rates.taxRate, rates.fees);
        expect(variableCost).not.toBeNull();
        if (variableCost == null) return;
        const margin = calculateContributionMargin(price, unitCost, variableCost);
        const expected =
          price -
          unitCost -
          price * (rates.taxRate / 100) -
          rates.fees.reduce((sum, fee) => sum + price * ((fee.percentage ?? 0) / 100), 0);
        expect(Math.abs(margin - expected)).toBeLessThanOrEqual(1e-6 + Math.abs(expected) * 1e-9);

        const higherPrice = price * 2;
        const higherVariable = calculateVariableCost(
          higherPrice,
          rates.taxRate,
          rates.fees,
        ) as number;
        const higherMargin = calculateContributionMargin(higherPrice, unitCost, higherVariable);
        expect(higherMargin).toBeGreaterThanOrEqual(margin - 1e-9);
      },
    );
    fc.assert(property);
  });

  it("ponto de equilíbrio: mais despesas fixas nunca reduz unidades; margem maior nunca aumenta", () => {
    const property = fc.property(
      fc.tuple(
        fc.double({ min: 0, max: 100_000, noNaN: true }),
        fc.double({ min: 0.01, max: 500, noNaN: true }),
        fc.double({ min: 0.01, max: 500, noNaN: true }),
      ),
      ([fixedExpenses, cmUnitLower, cmUnitHigher]) => {
        const [cmUnit, betterCmUnit] =
          cmUnitLower <= cmUnitHigher ? [cmUnitLower, cmUnitHigher] : [cmUnitHigher, cmUnitLower];
        const base = calculateBreakEvenUnits(fixedExpenses, cmUnit);
        expect(base.status).toBe("reachable");
        if (base.status !== "reachable") return;

        const moreExpenses = calculateBreakEvenUnits(fixedExpenses * 2, cmUnit);
        expect(moreExpenses.status).toBe("reachable");
        if (moreExpenses.status === "reachable") {
          expect(moreExpenses.rawUnits).toBeGreaterThanOrEqual(base.rawUnits - 1e-9);
          expect(base.roundedUnits).toBeGreaterThanOrEqual(base.rawUnits);
        }

        const betterMargin = calculateBreakEvenUnits(fixedExpenses, betterCmUnit);
        expect(betterMargin.status).toBe("reachable");
        if (betterMargin.status === "reachable") {
          expect(betterMargin.rawUnits).toBeLessThanOrEqual(base.rawUnits + 1e-9);
        }
      },
    );
    fc.assert(property);
  });

  it("margem unitária não positiva torna o ponto de equilíbrio inatingível, não inválido", () => {
    const property = fc.property(
      fc.tuple(
        fc.double({ min: 0, max: 100_000, noNaN: true }),
        fc.double({ min: -500, max: 0, noNaN: true }),
      ),
      ([fixedExpenses, nonPositiveCmUnit]) => {
        const result = calculateBreakEvenUnits(fixedExpenses, nonPositiveCmUnit);
        expect(result.status).toBe("unreachable");
        if (result.status === "unreachable") {
          expect(result.reason).toBe("NON_POSITIVE_CONTRIBUTION");
        }
      },
    );
    fc.assert(property);
  });

  it("sumFiniteNumbers retorna finito para entradas finitas e NaN quando há não finito", () => {
    const finiteProperty = fc.property(
      fc.array(fc.double({ min: -1e12, max: 1e12, noNaN: true }), { maxLength: 50 }),
      (values) => {
        const sum = sumFiniteNumbers(values);
        expect(Number.isFinite(sum)).toBe(true);
        // Referência exata em Decimal: a diferença permitida é só o arredondamento
        // final para double, não os erros acumulados da soma ingênua em float.
        const exact = values.reduce((acc, value) => acc.plus(value), new Decimal(0));
        const tolerance = Number.EPSILON * Math.max(1, Math.abs(sum)) * 4;
        expect(Math.abs(sum - exact.toNumber())).toBeLessThanOrEqual(tolerance);
      },
    );
    fc.assert(finiteProperty);

    const poisonProperty = fc.property(
      fc.tuple(
        fc.array(fc.double({ min: -1e6, max: 1e6, noNaN: true }), {
          minLength: 1,
          maxLength: 10,
        }),
        fc.constantFrom(Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY),
        fc.nat(10),
      ),
      ([values, poison, index]) => {
        const poisoned = [...values];
        poisoned.splice(index % poisoned.length, 0, poison);
        expect(sumFiniteNumbers(poisoned)).toBeNaN();
      },
    );
    fc.assert(poisonProperty);
  });

  it("toDecimalString com escala fixa arredonda de forma estável (round-trip)", () => {
    const property = fc.property(
      fc.double({ min: 0, max: 999_999, noNaN: true }),
      fc.integer({ min: 0, max: 6 }),
      (value, scale) => {
        const decimalString = toDecimalString(value, scale);
        const parsed = Number(decimalString);
        expect(Number.isFinite(parsed)).toBe(true);
        expect(Math.abs(parsed - value)).toBeLessThan(10 ** -scale + 1e-9);
        expect(toDecimalString(parsed, scale)).toBe(decimalString);
      },
    );
    fc.assert(property);
  });

  it("custo unitário maior, todo o resto igual ⇒ margem de contribuição não aumenta", () => {
    const property = fc.property(
      fc.tuple(validScenarioArbitrary, fc.double({ min: 0.01, max: 10_000, noNaN: true })),
      ([parts, extraUnitCost]) => {
        const base = calculateScenario(scenarioInput(parts));
        const higher = calculateScenario(
          scenarioInput(parts, { unitCost: parts.unitCost + extraUnitCost }),
        );
        // Result Type: `incomplete`/`invalid` não têm ordem definida contra
        // `ok`; só comparamos quando AMBOS os lados são `ok`. Caso contrário o
        // par é descartado — nunca tratado como margem zero.
        if (base.status !== "ok" || higher.status !== "ok") return;
        expect(higher.value.contributionMargin).toBeLessThanOrEqual(
          base.value.contributionMargin + 1e-9,
        );
      },
    );
    fc.assert(property, { numRuns: 1000 });
  });

  it("volume maior, todo o resto igual ⇒ receita não diminui", () => {
    const property = fc.property(
      fc.tuple(validScenarioArbitrary, fc.double({ min: 0.01, max: 1_000_000, noNaN: true })),
      ([parts, extraVolume]) => {
        const base = calculateScenario(scenarioInput(parts));
        const higher = calculateScenario(
          scenarioInput(parts, { volume: parts.volume + extraVolume }),
        );
        // Result Type: o par é descartado quando qualquer lado não é `ok`;
        // receita ausente (`incomplete`) não é receita zero.
        if (base.status !== "ok" || higher.status !== "ok") return;
        expect(higher.value.revenue).toBeGreaterThanOrEqual(base.value.revenue - 1e-9);
      },
    );
    fc.assert(property, { numRuns: 1000 });
  });
});
