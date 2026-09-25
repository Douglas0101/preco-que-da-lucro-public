/**
 * Texto de "Como calculamos?" ligado ao motor (§18.3).
 *
 * A regra do item é que a explicação NÃO pode divergir de `@/lib/finance`. Por
 * isso este módulo não recalcula nada: cada passo declara o campo do eco do
 * motor (`ScenarioResult`, serializado pelo BFF como decimal-string) que
 * alimenta o valor exibido, e o passo a passo é montado lendo esse eco. O
 * recálculo pelas mesmas funções exportadas do motor vive em
 * `src/test/calc-explainer.test.tsx`, que falha quando a fórmula declarada e o
 * motor divergem (mesma cadeia e mesmo contrato de campos).
 */

import type { FeeRow, ResolvedVolumeSource, ScenarioInput, ScenarioResult } from "@/lib/finance";
import { brl, pct } from "@/lib/format";

/**
 * Entradas do cenário com os números já resolvidos — o cenário só é explicado
 * quando o motor devolveu `ok`, então nada aqui é nulo. As chaves espelham
 * `ScenarioInput`; renomear um campo do motor quebra a compilação abaixo.
 */
export interface ScenarioExplainInput {
  price: number;
  unitCost: number;
  taxRate: number;
  fees: FeeRow[];
  fixedExpenses: number;
  volume: number;
}

/** Trava de compilação: as chaves do explicador seguem as do motor. */
type Assert<T extends true> = T;
type _ExplainInputMirrorsScenarioInput = Assert<
  ScenarioExplainInput extends Pick<ScenarioInput, keyof ScenarioExplainInput> ? true : false
>;

/**
 * Campos do eco do motor que carregam número (os únicos que podem virar passo).
 * As entradas (`price`, `unitCost`, `volume`) ficam de fora: a explicação do
 * resultado descreve o que o motor DERIVOU delas.
 */
export type ScenarioStepField = Exclude<
  {
    [K in keyof ScenarioResult]: ScenarioResult[K] extends number ? K : never;
  }[keyof ScenarioResult],
  "price" | "unitCost" | "volume"
>;

/** O mesmo valor chega cru do motor (número) e serializado pelo BFF (decimal-string). */
export type ScenarioStepValue = number | string;

/** Eco do motor lido pela explicação: os campos que viram passo + a origem do volume. */
export type ScenarioEcho = Record<ScenarioStepField, ScenarioStepValue> & {
  volumeSource: ResolvedVolumeSource;
};

export interface ScenarioStep {
  /** Campo do eco do motor que alimenta `value` — a UI não refaz a conta. */
  field: ScenarioStepField;
  label: string;
  formula: string;
  value: string;
}

interface ScenarioStepSpec {
  field: ScenarioStepField;
  label: string;
  formula: string;
  format: (value: ScenarioStepValue) => string;
}

/**
 * Fórmula do destaque de margem unitária de `/inicio`. É a MESMA string do
 * passo `contributionMarginPct` do cenário — o teste de paridade prende o passo
 * ao motor e o card importa daqui, então o KPI não consegue divergir sozinho.
 */
export const CONTRIBUTION_MARGIN_PCT_FORMULA =
  "margem de contribuição unitária ÷ preço de venda × 100";

/**
 * Passo a passo usado pelo resultado da simulação. A ordem é a da cadeia de
 * `calculateScenario`: custo variável, margem unitária, margem %, faturamento,
 * custos variáveis totais, margem total e resultado no escopo.
 */
export const SCENARIO_STEP_SPECS: readonly ScenarioStepSpec[] = [
  {
    field: "variableCost",
    label: "Custo variável unitário",
    formula: "preço × (imposto + taxas) ÷ 100",
    format: brl,
  },
  {
    field: "contributionMargin",
    label: "Margem de contribuição unitária",
    formula: "preço − custo unitário − custo variável unitário",
    format: brl,
  },
  {
    field: "contributionMarginPct",
    label: "Margem de contribuição (%)",
    formula: CONTRIBUTION_MARGIN_PCT_FORMULA,
    format: pct,
  },
  {
    field: "revenue",
    label: "Faturamento",
    formula: "preço × volume",
    format: brl,
  },
  {
    field: "totalVariable",
    label: "Custo variável total",
    formula: "(custo unitário + custo variável unitário) × volume",
    format: brl,
  },
  {
    field: "totalContribution",
    label: "Margem de contribuição total",
    formula: "margem de contribuição unitária × volume",
    format: brl,
  },
  {
    field: "result",
    label: "Resultado operacional no escopo informado",
    formula: "margem de contribuição total − despesas fixas no escopo",
    format: brl,
  },
];

/** Passo a passo do cenário, com os valores lidos do eco de `calculateScenario`. */
export function scenarioExplanation(result: ScenarioEcho): ScenarioStep[] {
  return SCENARIO_STEP_SPECS.map((spec) => ({
    field: spec.field,
    label: spec.label,
    formula: spec.formula,
    value: spec.format(result[spec.field]),
  }));
}
