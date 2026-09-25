import { describe, expect, it } from "vitest";
import { calculateBreakEvenSummary as sharedCalculateBreakEvenSummary } from "@/lib/break-even";
import { calculateBreakEvenSummary as serviceCalculateBreakEvenSummary } from "@/server/services/break-even.service";
import type { BreakEvenServiceInput } from "@/lib/break-even";

/**
 * Golden fixture de paridade (T1): valores gravados do comportamento atual do
 * motor (server fn calculateBreakEven → calculateBreakEvenSummary) na ONDA 2.
 * A função compartilhada usada pela exibição client-side em /ponto-equilibrio
 * deve reproduzir exatamente estes valores — qualquer drift do motor quebra a
 * paridade e este teste falha.
 */
type GoldenInput = {
  fixedExpenses: string[];
  price: string;
  contributionMargin: string;
  contributionMarginPct: string;
  desiredProfit: string | null;
  unitMode: "discrete" | "continuous";
};

// Fixture gravada como texto canônico; o branding é recuperado aqui.
function goldenInput(input: GoldenInput): BreakEvenServiceInput {
  return input as BreakEvenServiceInput;
}

const GOLDEN_CASES: Array<{
  name: string;
  input: BreakEvenServiceInput;
  expected: object;
}> = [
  {
    name: "discreto com lucro desejado (reachable + target)",
    input: goldenInput({
      fixedExpenses: ["3000.00", "150.50"],
      price: "45.90",
      contributionMargin: "12.3456",
      contributionMarginPct: "26.89",
      desiredProfit: "3000",
      unitMode: "discrete",
    }),
    expected: {
      status: "reachable",
      fixedExpenses: "3150.5000",
      units: {
        status: "reachable",
        rawUnits: "255.192133",
        roundedUnits: "256.000000",
        unitMode: "discrete",
      },
      revenue: "11716.2514",
      targetUnits: {
        status: "reachable",
        rawUnits: "498.193688",
        roundedUnits: "499.000000",
        unitMode: "discrete",
      },
      targetRevenue: "22904.1000",
    },
  },
  {
    name: "margem zero é explicitamente não atingível (unknown ≠ zero)",
    input: goldenInput({
      fixedExpenses: ["1000"],
      price: "10",
      contributionMargin: "0",
      contributionMarginPct: "20",
      desiredProfit: null,
      unitMode: "discrete",
    }),
    expected: {
      status: "unreachable",
      fixedExpenses: "1000.0000",
      units: {
        status: "unreachable",
        rawUnits: null,
        roundedUnits: null,
        unitMode: "discrete",
        reason: "NON_POSITIVE_CONTRIBUTION",
      },
      revenue: null,
      targetUnits: null,
      targetRevenue: null,
    },
  },
  {
    name: "despesa negativa retorna status invalid, nunca NaN formatado",
    input: goldenInput({
      fixedExpenses: ["-5"],
      price: "10",
      contributionMargin: "2",
      contributionMarginPct: "20",
      desiredProfit: null,
      unitMode: "discrete",
    }),
    expected: {
      status: "invalid",
      fixedExpenses: null,
      units: {
        status: "invalid",
        rawUnits: null,
        roundedUnits: null,
        unitMode: "discrete",
        errors: [
          {
            code: "INVALID_DECIMAL",
            field: "fixedExpenses[0]",
            message: "Informe um decimal finito dentro do intervalo permitido.",
          },
        ],
      },
      revenue: null,
      targetUnits: null,
      targetRevenue: null,
    },
  },
  {
    name: "contínuo sem lucro desejado preserva o valor bruto",
    input: goldenInput({
      fixedExpenses: ["1234.5678"],
      price: "19.99",
      contributionMargin: "7.03",
      contributionMarginPct: "35.16758379",
      desiredProfit: null,
      unitMode: "continuous",
    }),
    expected: {
      status: "reachable",
      fixedExpenses: "1234.5678",
      units: {
        status: "reachable",
        rawUnits: "175.614196",
        roundedUnits: "175.614196",
        unitMode: "continuous",
      },
      revenue: "3510.5278",
      targetUnits: null,
      targetRevenue: null,
    },
  },
];

describe("break-even paridade client/server (T1)", () => {
  it("a função compartilhada É a mesma função usada pelo server fn (paridade por construção)", () => {
    expect(sharedCalculateBreakEvenSummary).toBe(serviceCalculateBreakEvenSummary);
  });

  for (const golden of GOLDEN_CASES) {
    it(`reproduz o golden atual: ${golden.name}`, () => {
      expect(sharedCalculateBreakEvenSummary(golden.input)).toEqual(golden.expected);
    });
  }

  it("resultados não atingíveis e inválidos nunca serializam número (INV-006/009)", () => {
    for (const golden of GOLDEN_CASES) {
      const result = sharedCalculateBreakEvenSummary(golden.input);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toContain("NaN");
      expect(serialized).not.toContain("Infinity");
      if (result.units.status !== "reachable") {
        expect(result.units.rawUnits).toBeNull();
        expect(result.units.roundedUnits).toBeNull();
      }
    }
  });
});
