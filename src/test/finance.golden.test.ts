import { describe, expect, it } from "vitest";

import {
  calculateBreakEvenRevenue,
  calculateBreakEvenUnits,
  calculateContributionMargin,
  calculateContributionMarginPct,
  calculateIngredientCost,
  calculatePackagingCost,
  calculatePriceFormation,
  isFactualVolumeSource,
  calculateRecipeCost,
  calculateRequiredSalesForProfit,
  calculateScenario,
  calculateUnitCost,
  calculateVariableCost,
  calcIncomplete,
  calcInvalid,
  calcOk,
  computeProduct,
  computeProductCost,
  convertUnit,
  sumFiniteNumbers,
  unitDimension,
  type CalculationResult,
  type PriceFormationInput,
  type ScenarioInput,
  type VolumeSource,
} from "@/lib/finance";

/** Desembrulha um Result esperando `ok` — falha o teste caso contrário. */
function unwrap<T>(r: CalculationResult<T>): T {
  if (r.status !== "ok") throw new Error(`expected ok, got ${r.status}`);
  return r.value;
}

/**
 * Golden tests (F0-03 — Plano Mestre §5 / V7 Apêndice D, lote 01).
 *
 * Testes de caracterização do motor financeiro. Comportamentos ainda
 * incorretos são marcados com `golden:` e o lote da sequência determinada
 * (Plano §40) que os corrige. Nenhum valor aqui pode ser "corrigido" sem o
 * lote correspondente.
 *
 * Lotes já aplicados: 03 (contrato CalculationResult), 04 (unknown ≠ zero),
 * 05 (número inválido ≠ zero), 06 (origem explícita do volume), 07
 * (formação explícita de preço), 08 (unidades) e 09 (arredondamento).
 * `null` permanece incomplete; valores
 * numéricos inválidos e resultados não finitos usam `invalid`.
 */

describe("conversão de unidades", () => {
  it("converte dentro de massa, volume e contagem", () => {
    expect(convertUnit(1, "kg", "g")).toBe(1000);
    expect(convertUnit(1, "l", "ml")).toBe(1000);
    expect(convertUnit(1, "dúzia", "unidade")).toBe(12);
    expect(convertUnit(200, "g", "g")).toBe(200);
  });

  it("retorna null para unidades incompatíveis", () => {
    expect(convertUnit(1, "kg", "l")).toBeNull();
    expect(convertUnit(1, "unidade", "g")).toBeNull();
    expect(convertUnit(1, "unidade-inventada", "unidade-inventada")).toBeNull();
  });

  it("classifica produção e só converte por fator contextual confirmado", () => {
    expect(unitDimension("lote")).toBe("production");
    expect(unitDimension("porção")).toBe("production");
    expect(convertUnit(1, "lote", "porção")).toBeNull();
    expect(
      convertUnit(1, "lote", "porção", {
        fromUnit: "lote",
        toUnit: "porção",
        factor: "12",
        contextId: "fixture-production",
      }),
    ).toBe(12);
  });
});

describe("custo de ingredientes e receita", () => {
  it("custo normal: farinha 200 g de um pacote de R$ 6,00/1 kg custa R$ 1,20", () => {
    const cost = calculateIngredientCost({
      used_qty: 200,
      used_unit: "g",
      package_price: 6,
      package_qty: 1,
      package_unit: "kg",
    });
    expect(cost).toBeCloseTo(1.2, 10);
  });

  it("custo faltante: dados incompletos retornam null (desconhecido ≠ zero)", () => {
    expect(
      calculateIngredientCost({
        used_qty: 200,
        used_unit: "g",
        package_price: null,
        package_qty: null,
        package_unit: null,
      }),
    ).toBeNull();
  });

  it("unidade incompatível: custo permanece desconhecido, nunca zero", () => {
    expect(
      calculateIngredientCost({
        used_qty: 200,
        used_unit: "g",
        package_price: 6,
        package_qty: 1,
        package_unit: "l",
      }),
    ).toBeNull();

    expect(
      computeProductCost({
        ingredients: [
          {
            used_qty: 200,
            used_unit: "g",
            package_price: 6,
            package_qty: 1,
            package_unit: "l",
          },
        ],
        packaging: [],
        yieldQty: 10,
      }),
    ).toMatchObject({
      status: "incomplete",
      missing: [{ field: "ingredients[0].conversion_context" }],
    });
  });

  it("custo da receita soma os ingredientes", () => {
    const rows = [
      { used_qty: 200, used_unit: "g", package_price: 6, package_qty: 1, package_unit: "kg" },
      {
        used_qty: 2,
        used_unit: "unidade",
        package_price: 12,
        package_qty: 1,
        package_unit: "dúzia",
      },
    ];
    expect(calculateRecipeCost(rows)).toBeCloseTo(1.2 + 2, 10);
  });
});

describe("custo unitário", () => {
  it("yield normal divide o custo da receita e soma embalagem", () => {
    expect(calculateUnitCost(12, 10, 0.5)).toBeCloseTo(1.7, 10);
  });

  it("yield zero conhecido torna o custo unitário inválido (NaN)", () => {
    expect(Number.isNaN(calculateUnitCost(12, 0, 0.5))).toBe(true);
  });

  it("custo unitário propaga custo de receita ou embalagem desconhecido", () => {
    expect(calculateUnitCost(null, 10, 0.5)).toBeNull();
    expect(calculateUnitCost(12, 10, null)).toBeNull();
  });

  it("yield desconhecido torna o produto incompleto (FIN-02)", () => {
    const result = computeProduct({
      ingredients: [
        { used_qty: 200, used_unit: "g", package_price: 6, package_qty: 1, package_unit: "kg" },
      ],
      packaging: [],
      yieldQty: null,
      price: 5,
      taxRate: 10,
      fees: [],
    });
    expect(result.status).toBe("incomplete");
    if (result.status === "incomplete") {
      expect(result.missing.map((m) => m.field)).toContain("yieldQty");
    }
  });

  it("alíquota desconhecida torna o produto incompleto (FIN-03)", () => {
    const result = computeProduct({
      ingredients: [],
      packaging: [],
      yieldQty: 10,
      price: 10,
      taxRate: null,
      fees: [],
    });
    expect(result.status).toBe("incomplete");
    if (result.status === "incomplete") {
      expect(result.missing.map((m) => m.field)).toContain("taxRate");
    }
  });

  it("embalagem com unidades por pacote inválidas produz NaN, nunca custo zero", () => {
    expect(
      Number.isNaN(calculatePackagingCost([{ package_price: 50, units_per_package: 0 }])),
    ).toBe(true);
    expect(calculatePackagingCost([{ package_price: 50, units_per_package: 100 }])).toBeCloseTo(
      0.5,
      10,
    );
  });
});

describe("margem de contribuição", () => {
  it("margem negativa quando o preço não cobre custos", () => {
    const variable = calculateVariableCost(5, 10, [{ percentage: 5 }]);
    if (variable === null) throw new Error("expected number, got null");
    expect(variable).toBeCloseTo(0.75, 10);
    const cm = calculateContributionMargin(5, 6, variable);
    expect(cm).toBeCloseTo(-1.75, 10);
    expect(calculateContributionMarginPct(5, cm)).toBeCloseTo(-35, 10);
  });

  it("percentual com preço zero retorna 0", () => {
    expect(calculateContributionMarginPct(0, 5)).toBe(0);
  });
});

describe("ponto de equilíbrio", () => {
  it("contribuição zero torna o break-even explicitamente não atingível", () => {
    expect(calculateBreakEvenUnits(6000, 0)).toMatchObject({
      status: "unreachable",
      rawUnits: null,
      roundedUnits: null,
      reason: "NON_POSITIVE_CONTRIBUTION",
    });
    expect(calculateBreakEvenRevenue(6000, 0)).toBeNull();
  });

  it("margem negativa também torna o break-even impossível", () => {
    expect(calculateBreakEvenUnits(6000, -1).status).toBe("unreachable");
    expect(calculateRequiredSalesForProfit(6000, 2000, -1).status).toBe("unreachable");
  });

  it("break-even discreto preserva o bruto e usa ceil operacional", () => {
    const result = calculateBreakEvenUnits(6000, 7);
    expect(result.status).toBe("reachable");
    if (result.status === "reachable") {
      expect(result.rawUnits).toBeCloseTo(857.142857, 5);
      expect(result.roundedUnits).toBe(858);
    }

    const continuous = calculateBreakEvenUnits(6000, 7, "continuous");
    expect(continuous.status).toBe("reachable");
    if (continuous.status === "reachable") {
      expect(continuous.roundedUnits).toBeCloseTo(continuous.rawUnits, 10);
    }

    const fractional = calculateBreakEvenUnits(101, 10, "discrete");
    expect(fractional.status).toBe("reachable");
    if (fractional.status === "reachable") {
      expect(fractional.rawUnits).toBeCloseTo(10.1, 10);
      expect(fractional.roundedUnits).toBe(11);
    }
  });
});

describe("quantidades fracionárias", () => {
  it("meio quilo e frações de unidade fluem como ponto flutuante", () => {
    const cost = calculateIngredientCost({
      used_qty: 0.5,
      used_unit: "kg",
      package_price: 6,
      package_qty: 1,
      package_unit: "kg",
    });
    expect(cost).toBeCloseTo(3, 10);
  });
});

describe("cenários (exemplo canônico da Diretriz §12)", () => {
  const base = {
    unitCost: 4,
    taxRate: 0,
    fees: [],
    fixedExpenses: 6000,
    volume: 700,
    volumeSource: "manual_simulation" as const,
  };

  it("simulação manual: preço R$ 10 gera prejuízo de R$ 1.800", () => {
    const result = unwrap(calculateScenario({ ...base, price: 10 }));
    expect(result.contributionMargin).toBeCloseTo(6, 10);
    expect(result.contributionMarginPct).toBeCloseTo(60, 10);
    expect(result.breakEvenUnits).toMatchObject({
      status: "reachable",
      rawUnits: 1000,
      roundedUnits: 1000,
    });
    expect(result.breakEvenRevenue).toBeCloseTo(10000, 10);
    expect(result.revenue).toBe(7000);
    expect(result.result).toBeCloseTo(-1800, 10);
  });

  it("cenário simulado: preço R$ 11 reduz o prejuízo para R$ 1.100", () => {
    const result = unwrap(calculateScenario({ ...base, price: 11 }));
    expect(result.contributionMargin).toBeCloseTo(7, 10);
    expect(result.result).toBeCloseTo(-1100, 10);
  });
});

describe("proveniência do volume (FIN-004 — lote 06)", () => {
  const scenario = (volumeSource: VolumeSource, volume: number | null = 700): ScenarioInput => ({
    price: 10,
    unitCost: 4,
    taxRate: 0,
    fees: [],
    fixedExpenses: 6000,
    volume,
    volumeSource,
  });

  it.each(["real", "manual_simulation", "forecast"] as const)(
    "preserva volume e origem resolvida %s no resultado",
    (volumeSource) => {
      const result = calculateScenario(scenario(volumeSource));
      expect(result.status).toBe("ok");
      if (result.status === "ok") {
        expect(result.value.volume).toBe(700);
        expect(result.value.volumeSource).toBe(volumeSource);
      }
    },
  );

  it.each([
    ["real", true],
    ["manual_simulation", false],
    ["forecast", false],
    ["unknown", false],
  ] as const)("somente %s é elegível como origem factual", (volumeSource, expected) => {
    expect(isFactualVolumeSource(volumeSource)).toBe(expected);
  });

  it("origem desconhecida sem volume permanece incompleta", () => {
    const result = calculateScenario(scenario("unknown", null));
    expect(result).toMatchObject({ status: "incomplete", missing: [{ field: "volume" }] });
  });

  it("origem conhecida sem volume permanece incompleta", () => {
    const result = calculateScenario(scenario("manual_simulation", null));
    expect(result).toMatchObject({ status: "incomplete", missing: [{ field: "volume" }] });
  });

  it("rejeita volume numérico com origem desconhecida", () => {
    const result = calculateScenario(scenario("unknown"));
    expect(result).toMatchObject({
      status: "invalid",
      errors: [{ code: "INVALID_VOLUME_SOURCE", field: "volumeSource" }],
    });
  });

  it("rejeita origem não suportada recebida em runtime", () => {
    const input = {
      ...scenario("manual_simulation"),
      volumeSource: "legacy",
    } as unknown as ScenarioInput;
    const result = calculateScenario(input);
    expect(result).toMatchObject({
      status: "invalid",
      errors: [{ code: "INVALID_VOLUME_SOURCE", field: "volumeSource" }],
    });
  });

  it("zero manual é volume conhecido e válido", () => {
    const result = calculateScenario(scenario("manual_simulation", 0));
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.volume).toBe(0);
      expect(result.value.revenue).toBe(0);
      expect(result.value.result).toBe(-6000);
    }
  });
});

describe("formação explícita de preço (FIN-005 — lote 07)", () => {
  const input = (overrides: Partial<PriceFormationInput> = {}): PriceFormationInput => ({
    directUnitCost: 10,
    nonPercentageVariableUnitCost: 2,
    taxRate: 10,
    fees: [{ percentage: 5 }],
    targetContributionRate: 20,
    marketReference: 22,
    ...overrides,
  });

  it("calcula mínimo e preço para margem-alvo pelo Modelo A do SDD", () => {
    const result = calculatePriceFormation(input());

    expect(unwrap(result.minimumSustainablePrice)).toBeCloseTo(12 / 0.85, 12);
    expect(unwrap(result.targetMarginPrice)).toBeCloseTo(12 / 0.65, 12);
    expect(unwrap(result.marketReference)).toBe(22);
  });

  it("não arredonda o preço dentro do motor", () => {
    const result = calculatePriceFormation(input());
    const minimum = unwrap(result.minimumSustainablePrice);

    expect(minimum).toBe(12 / 0.85);
    expect(minimum).not.toBe(14.12);
  });

  it("margem alvo ausente não oculta mínimo nem mercado", () => {
    const result = calculatePriceFormation(input({ targetContributionRate: null }));

    expect(result.minimumSustainablePrice.status).toBe("ok");
    expect(result.targetMarginPrice).toMatchObject({
      status: "incomplete",
      missing: [{ field: "targetContributionRate" }],
    });
    expect(result.marketReference.status).toBe("ok");
  });

  it("custo variável unitário ausente não vira zero", () => {
    const result = calculatePriceFormation(input({ nonPercentageVariableUnitCost: null }));

    expect(result.minimumSustainablePrice).toMatchObject({
      status: "incomplete",
      missing: [{ field: "nonPercentageVariableUnitCost" }],
    });
    expect(result.targetMarginPrice.status).toBe("incomplete");
    expect(result.marketReference.status).toBe("ok");
  });

  it("zeros explícitos são válidos e margem zero coincide com o mínimo", () => {
    const result = calculatePriceFormation(
      input({
        nonPercentageVariableUnitCost: 0,
        taxRate: 0,
        fees: [],
        targetContributionRate: 0,
      }),
    );

    expect(unwrap(result.minimumSustainablePrice)).toBe(10);
    expect(unwrap(result.targetMarginPrice)).toBe(10);
  });

  it("denominador da margem inválido não apaga o mínimo calculável", () => {
    const result = calculatePriceFormation(
      input({ taxRate: 60, fees: [], targetContributionRate: 40 }),
    );

    expect(unwrap(result.minimumSustainablePrice)).toBe(30);
    expect(result.targetMarginPrice).toMatchObject({
      status: "invalid",
      errors: [{ code: "INVALID_NUMBER", field: "targetContributionRate" }],
    });
  });

  it("invalid prevalece por saída sem contaminar resultados independentes", () => {
    const result = calculatePriceFormation(
      input({ directUnitCost: null, targetContributionRate: Number.NaN }),
    );

    expect(result.minimumSustainablePrice.status).toBe("incomplete");
    expect(result.targetMarginPrice).toMatchObject({
      status: "invalid",
      errors: [{ code: "INVALID_NUMBER", field: "targetContributionRate" }],
    });
    expect(result.marketReference.status).toBe("ok");
  });

  it("referência de mercado é validada sem afetar os cálculos internos", () => {
    const missing = calculatePriceFormation(input({ marketReference: null }));
    const invalid = calculatePriceFormation(input({ marketReference: -1 }));

    expect(missing.marketReference).toMatchObject({
      status: "incomplete",
      missing: [{ field: "marketReference" }],
    });
    expect(invalid.marketReference).toMatchObject({
      status: "invalid",
      errors: [{ code: "INVALID_NUMBER", field: "marketReference" }],
    });
    expect(invalid.minimumSustainablePrice.status).toBe("ok");
    expect(invalid.targetMarginPrice.status).toBe("ok");
  });

  it("overflow do custo modelado retorna invalid", () => {
    const result = calculatePriceFormation(
      input({
        directUnitCost: Number.MAX_VALUE,
        nonPercentageVariableUnitCost: Number.MAX_VALUE,
      }),
    );

    expect(result.minimumSustainablePrice).toMatchObject({
      status: "invalid",
      errors: [{ code: "NON_FINITE_RESULT", field: "modeledUnitCost" }],
    });
    expect(result.targetMarginPrice.status).toBe("invalid");
  });

  it("aumentar custo aumenta os dois preços, mantendo as demais entradas", () => {
    const lower = calculatePriceFormation(input({ directUnitCost: 10 }));
    const higher = calculatePriceFormation(input({ directUnitCost: 11 }));

    expect(unwrap(higher.minimumSustainablePrice)).toBeGreaterThan(
      unwrap(lower.minimumSustainablePrice),
    );
    expect(unwrap(higher.targetMarginPrice)).toBeGreaterThan(unwrap(lower.targetMarginPrice));
  });

  it("calcula custo direto sem depender do preço atual", () => {
    const costInput = {
      ingredients: [
        {
          used_qty: 200,
          used_unit: "g",
          package_price: 6,
          package_qty: 1,
          package_unit: "kg",
        },
      ],
      packaging: [{ package_price: 50, units_per_package: 100 }],
      yieldQty: 10,
    };
    const cost = computeProductCost(costInput);
    const product = computeProduct({
      ...costInput,
      price: null,
      taxRate: 0,
      fees: [],
    });

    expect(cost.status).toBe("ok");
    expect(product).toMatchObject({ status: "incomplete", missing: [{ field: "price" }] });
  });
});

describe("contrato CalculationResult (FIN-001 — lote 03)", () => {
  it("calcOk envelopa o valor com warnings vazios por padrão", () => {
    expect(calcOk(42)).toEqual({ status: "ok", value: 42, warnings: [] });
  });

  it("calcOk aceita warnings explícitos", () => {
    const w = { code: "W_TEST", message: "aviso" };
    expect(calcOk(1, [w])).toEqual({ status: "ok", value: 1, warnings: [w] });
  });

  it("calcIncomplete carrega os campos faltantes e warnings vazios por padrão", () => {
    expect(calcIncomplete([{ field: "yieldQty" }])).toEqual({
      status: "incomplete",
      missing: [{ field: "yieldQty" }],
      warnings: [],
    });
  });

  it("calcIncomplete aceita warnings explícitos", () => {
    const w = { code: "W_TEST", message: "aviso" };
    expect(calcIncomplete([{ field: "price" }], [w])).toEqual({
      status: "incomplete",
      missing: [{ field: "price" }],
      warnings: [w],
    });
  });

  it("calcInvalid carrega os erros", () => {
    const e = { code: "E_TEST", message: "inválido" };
    expect(calcInvalid([e])).toEqual({ status: "invalid", errors: [e] });
  });

  it("computeProduct retorna status ok com warnings vazios para entradas válidas", () => {
    const r = computeProduct({
      ingredients: [],
      packaging: [],
      yieldQty: 10,
      price: 10,
      taxRate: 10,
      fees: [],
    });
    expect(r).toMatchObject({ status: "ok", warnings: [] });
  });

  it("calculateScenario retorna status ok com warnings vazios para entradas válidas", () => {
    const r = calculateScenario({
      price: 10,
      unitCost: 4,
      taxRate: 0,
      fees: [],
      fixedExpenses: 6000,
      volume: 700,
      volumeSource: "manual_simulation",
    });
    expect(r).toMatchObject({ status: "ok", warnings: [] });
  });
});

describe("política unknown ≠ zero (FIN-002 — lote 04)", () => {
  it("ingrediente sem preço de embalagem torna o produto incompleto (FIN-01)", () => {
    const result = computeProduct({
      ingredients: [
        { used_qty: 200, used_unit: "g", package_price: null, package_qty: 1, package_unit: "kg" },
      ],
      packaging: [],
      yieldQty: 10,
      price: 5,
      taxRate: 10,
      fees: [],
    });
    expect(result.status).toBe("incomplete");
    if (result.status === "incomplete") {
      expect(result.missing.map((m) => m.field)).toContain("ingredients[0].package_price");
    }
  });

  it("percentual de taxa desconhecido torna o produto incompleto", () => {
    const result = computeProduct({
      ingredients: [],
      packaging: [],
      yieldQty: 10,
      price: 5,
      taxRate: 10,
      fees: [{ percentage: null }],
    });
    expect(result.status).toBe("incomplete");
    if (result.status === "incomplete") {
      expect(result.missing.map((m) => m.field)).toContain("fees[0].percentage");
    }
  });

  it("preço desconhecido torna o produto incompleto", () => {
    const result = computeProduct({
      ingredients: [],
      packaging: [],
      yieldQty: 10,
      price: null,
      taxRate: 10,
      fees: [],
    });
    expect(result.status).toBe("incomplete");
    if (result.status === "incomplete") {
      expect(result.missing.map((m) => m.field)).toContain("price");
    }
  });

  it("custo da receita propaga null de ingrediente incompleto", () => {
    expect(
      calculateRecipeCost([
        { used_qty: 200, used_unit: "g", package_price: 6, package_qty: 1, package_unit: "kg" },
        {
          used_qty: 1,
          used_unit: "unidade",
          package_price: null,
          package_qty: null,
          package_unit: null,
        },
      ]),
    ).toBeNull();
  });

  it("custo variável com preço, alíquota ou taxa desconhecida retorna null", () => {
    expect(calculateVariableCost(null, 5, [])).toBeNull();
    expect(calculateVariableCost(10, null, [])).toBeNull();
    expect(calculateVariableCost(10, 5, [{ percentage: null }])).toBeNull();
  });

  it("cenário com alíquota desconhecida fica incompleto", () => {
    const result = calculateScenario({
      price: 10,
      unitCost: 4,
      taxRate: null,
      fees: [],
      fixedExpenses: 6000,
      volume: 700,
      volumeSource: "manual_simulation",
    });
    expect(result.status).toBe("incomplete");
    if (result.status === "incomplete") {
      expect(result.missing.map((m) => m.field)).toContain("taxRate");
    }
  });

  it.each(["price", "unitCost", "fixedExpenses", "volume"] as const)(
    "cenário com %s desconhecido fica incompleto",
    (field) => {
      const input: ScenarioInput = {
        price: 10,
        unitCost: 4,
        taxRate: 0,
        fees: [],
        fixedExpenses: 6000,
        volume: 700,
        volumeSource: "manual_simulation",
      };
      input[field] = null;
      const result = calculateScenario(input);
      expect(result.status).toBe("incomplete");
      if (result.status === "incomplete") {
        expect(result.missing.map((m) => m.field)).toEqual([field]);
      }
    },
  );

  it("cenário com taxa de venda desconhecida fica incompleto", () => {
    const result = calculateScenario({
      price: 10,
      unitCost: 4,
      taxRate: 0,
      fees: [{ percentage: null }],
      fixedExpenses: 6000,
      volume: 700,
      volumeSource: "manual_simulation",
    });
    expect(result.status).toBe("incomplete");
    if (result.status === "incomplete") {
      expect(result.missing.map((m) => m.field)).toEqual(["fees[0].percentage"]);
    }
  });

  it("zero conhecido permanece válido: embalagem de R$ 0 custa R$ 0 (V7 §8.3)", () => {
    expect(
      calculateIngredientCost({
        used_qty: 200,
        used_unit: "g",
        package_price: 0,
        package_qty: 1,
        package_unit: "kg",
      }),
    ).toBe(0);
  });

  it("alíquota zero conhecida é válida e zera o custo variável (V7 §8.3)", () => {
    const result = computeProduct({
      ingredients: [],
      packaging: [],
      yieldQty: 10,
      price: 10,
      taxRate: 0,
      fees: [],
    });
    expect(unwrap(result).variableCost).toBe(0);
  });

  it("preço e taxa zero conhecidos permanecem válidos (V7 §8.3)", () => {
    const result = computeProduct({
      ingredients: [],
      packaging: [],
      yieldQty: 10,
      price: 0,
      taxRate: 0,
      fees: [{ percentage: 0 }],
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.variableCost).toBe(0);
      expect(result.value.contributionMarginPct).toBe(0);
    }
  });

  it("produto com todos os campos desconhecidos agrega todos os missing", () => {
    const result = computeProduct({
      ingredients: [
        {
          used_qty: 1,
          used_unit: "g",
          package_price: null,
          package_qty: null,
          package_unit: null,
        },
      ],
      packaging: [],
      yieldQty: null,
      price: null,
      taxRate: null,
      fees: [{ percentage: null }],
    });
    expect(result.status).toBe("incomplete");
    if (result.status === "incomplete") {
      expect(result.missing.map((m) => m.field)).toEqual([
        "ingredients[0].package_price",
        "ingredients[0].package_qty",
        "ingredients[0].package_unit",
        "fees[0].percentage",
        "yieldQty",
        "price",
        "taxRate",
      ]);
    }
  });
});

describe("política invalid number ≠ zero (FIN-003 — lote 05)", () => {
  const validScenario = (): ScenarioInput => ({
    price: 10,
    unitCost: 4,
    taxRate: 0,
    fees: [],
    fixedExpenses: 6000,
    volume: 700,
    volumeSource: "manual_simulation",
  });

  type ProductInput = Parameters<typeof computeProduct>[0];
  const validProduct = (): ProductInput => ({
    ingredients: [
      {
        used_qty: 200,
        used_unit: "g",
        package_price: 6,
        package_qty: 1,
        package_unit: "kg",
      },
    ],
    packaging: [{ package_price: 50, units_per_package: 100 }],
    yieldQty: 10,
    price: 10,
    taxRate: 0,
    fees: [{ percentage: 1 }],
  });

  const nonFiniteFields = ["price", "unitCost", "taxRate", "fixedExpenses", "volume"] as const;
  const nonFiniteValues = [Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY];

  it.each(
    nonFiniteFields.flatMap((field) => nonFiniteValues.map((value) => [field, value] as const)),
  )("cenário com %s=%s retorna invalid", (field, value) => {
    const input = validScenario();
    input[field] = value;
    const result = calculateScenario(input);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.errors).toEqual([expect.objectContaining({ code: "INVALID_NUMBER", field })]);
    }
  });

  const productNumericFields: Array<{
    field: string;
    set: (input: ProductInput, value: number) => void;
  }> = [
    {
      field: "ingredients[0].used_qty",
      set: (input, value) => (input.ingredients[0].used_qty = value),
    },
    {
      field: "ingredients[0].package_price",
      set: (input, value) => (input.ingredients[0].package_price = value),
    },
    {
      field: "ingredients[0].package_qty",
      set: (input, value) => (input.ingredients[0].package_qty = value),
    },
    {
      field: "packaging[0].package_price",
      set: (input, value) => (input.packaging[0].package_price = value),
    },
    {
      field: "packaging[0].units_per_package",
      set: (input, value) => (input.packaging[0].units_per_package = value),
    },
    { field: "yieldQty", set: (input, value) => (input.yieldQty = value) },
    { field: "price", set: (input, value) => (input.price = value) },
    { field: "taxRate", set: (input, value) => (input.taxRate = value) },
    {
      field: "fees[0].percentage",
      set: (input, value) => (input.fees[0].percentage = value),
    },
  ];

  it.each(
    productNumericFields.flatMap(({ field, set }) =>
      nonFiniteValues.map((value) => [field, value, set] as const),
    ),
  )("produto com %s=%s retorna invalid", (field, value, set) => {
    const input = validProduct();
    set(input, value);
    const result = computeProduct(input);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.errors).toContainEqual(
        expect.objectContaining({ code: "INVALID_NUMBER", field }),
      );
    }
  });

  it.each([
    ["price", -1],
    ["unitCost", -1],
    ["taxRate", -1],
    ["taxRate", 101],
    ["fixedExpenses", -1],
    ["volume", -1],
  ] as const)("cenário com %s=%s fora do domínio retorna invalid", (field, value) => {
    const input = validScenario();
    input[field] = value;
    const result = calculateScenario(input);
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.errors).toEqual([expect.objectContaining({ code: "INVALID_NUMBER", field })]);
    }
  });

  it.each([-1, 101, Number.NaN, Number.POSITIVE_INFINITY])(
    "taxa de venda inválida (%s) retorna invalid",
    (percentage) => {
      const result = calculateScenario({
        ...validScenario(),
        fees: [{ percentage }],
      });
      expect(result.status).toBe("invalid");
      if (result.status === "invalid") {
        expect(result.errors).toEqual([
          expect.objectContaining({
            code: "INVALID_NUMBER",
            field: "fees[0].percentage",
          }),
        ]);
      }
    },
  );

  it.each([
    [100, []],
    [90, [10]],
    [80, [10, 10]],
  ] as const)("imposto %s + taxas %s igual a 100%% retorna invalid", (taxRate, percentages) => {
    const result = calculateScenario({
      ...validScenario(),
      taxRate,
      fees: percentages.map((percentage) => ({ percentage })),
    });
    expect(result).toMatchObject({
      status: "invalid",
      errors: [{ code: "INVALID_NUMBER", field: "rateOnGrossPrice" }],
    });
  });

  it("subtotal conhecido de 100% prevalece sobre taxa ausente", () => {
    const result = calculateScenario({
      ...validScenario(),
      taxRate: null,
      fees: [{ percentage: 100 }],
    });
    expect(result).toMatchObject({
      status: "invalid",
      errors: [{ code: "INVALID_NUMBER", field: "rateOnGrossPrice" }],
    });
  });

  it("produto agrega todos os campos numéricos inválidos", () => {
    const result = computeProduct({
      ingredients: [
        {
          used_qty: 0,
          used_unit: "g",
          package_price: -1,
          package_qty: 0,
          package_unit: "kg",
        },
      ],
      packaging: [{ package_price: Number.NaN, units_per_package: 0 }],
      yieldQty: 0,
      price: -1,
      taxRate: 101,
      fees: [{ percentage: -1 }],
    });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.errors.map((error) => error.field)).toEqual([
        "ingredients[0].used_qty",
        "ingredients[0].package_price",
        "ingredients[0].package_qty",
        "packaging[0].package_price",
        "packaging[0].units_per_package",
        "fees[0].percentage",
        "yieldQty",
        "price",
        "taxRate",
      ]);
      expect(result.errors.every((error) => error.code === "INVALID_NUMBER")).toBe(true);
    }
  });

  it("folhas propagam número inválido como NaN, nunca null ou zero", () => {
    expect(
      Number.isNaN(
        calculateIngredientCost({
          used_qty: 0,
          used_unit: "g",
          package_price: 6,
          package_qty: 1,
          package_unit: "kg",
        }),
      ),
    ).toBe(true);
    expect(
      Number.isNaN(
        calculateIngredientCost({
          used_qty: Number.NaN,
          used_unit: "g",
          package_price: null,
          package_qty: null,
          package_unit: null,
        }),
      ),
    ).toBe(true);
    expect(
      Number.isNaN(
        calculateRecipeCost([
          {
            used_qty: 1,
            used_unit: "g",
            package_price: null,
            package_qty: null,
            package_unit: null,
          },
          {
            used_qty: 0,
            used_unit: "g",
            package_price: 6,
            package_qty: 1,
            package_unit: "kg",
          },
        ]),
      ),
    ).toBe(true);
    expect(
      Number.isNaN(calculatePackagingCost([{ package_price: 50, units_per_package: 0 }])),
    ).toBe(true);
    expect(Number.isNaN(calculateUnitCost(null, 0, 0.5))).toBe(true);
    expect(Number.isNaN(calculateVariableCost(null, 100, []))).toBe(true);
    expect(Number.isNaN(calculateContributionMarginPct(Number.NaN, 5))).toBe(true);
    expect(calculateBreakEvenUnits(Number.POSITIVE_INFINITY, 5).status).toBe("invalid");
    expect(Number.isNaN(sumFiniteNumbers([1, Number.POSITIVE_INFINITY]))).toBe(true);
    expect(Number.isNaN(sumFiniteNumbers([Number.MAX_VALUE, Number.MAX_VALUE]))).toBe(true);
    expect(sumFiniteNumbers([1, 2, 3])).toBe(6);
  });

  it("overflow de resultado derivado retorna invalid", () => {
    const product = computeProduct({
      ingredients: [],
      packaging: [{ package_price: Number.MAX_VALUE, units_per_package: Number.MIN_VALUE }],
      yieldQty: 1,
      price: 10,
      taxRate: 0,
      fees: [],
    });
    expect(product).toMatchObject({
      status: "invalid",
      errors: [{ code: "NON_FINITE_RESULT", field: "packagingCost" }],
    });

    const scenario = calculateScenario({
      ...validScenario(),
      price: Number.MAX_VALUE,
      unitCost: 0,
      fixedExpenses: 0,
      volume: 2,
    });
    expect(scenario).toMatchObject({
      status: "invalid",
      errors: [{ code: "NON_FINITE_RESULT", field: "revenue" }],
    });
  });

  it("break-even não atingível usa estado explícito e não Infinity", () => {
    const result = calculateScenario({
      ...validScenario(),
      price: 10,
      unitCost: 10,
      fixedExpenses: 6000,
    });
    expect(result.status).toBe("ok");
    if (result.status === "ok") {
      expect(result.value.breakEvenUnits.status).toBe("unreachable");
      expect(result.value.breakEvenRevenue).toBeNull();
    }
  });

  it("invalid prevalece quando a mesma entrada também contém ausência", () => {
    const result = calculateScenario({
      ...validScenario(),
      price: null,
      unitCost: Number.NaN,
    });
    expect(result.status).toBe("invalid");
    if (result.status === "invalid") {
      expect(result.errors.map((error) => error.field)).toEqual(["unitCost"]);
    }
  });
});
