/**
 * Invariantes do Result Type financeiro — Fase C (Contract Guard).
 *
 * `finance.golden.test.ts` fixa os VALORES canônicos do motor (12 casos de
 * F0-03 e a matriz §33). Este arquivo fixa as PROPRIEDADES que o golden não
 * afirma: o que o motor faz com o status, e não com o número.
 *
 * As cinco propriedades:
 *   P1 `incomplete` nunca é convertido em `ok` com valor inventado;
 *   P2 `invalid` nunca é rebaixado a `incomplete` (a distinção é load-bearing:
 *      `incomplete` diz "falta dado", `invalid` diz "o dado é inaproveitável" —
 *      colá-los faz a UI pedir ao usuário algo que já está errado);
 *   P3 `warnings` são propagadas, nunca engolidas;
 *   P4 fechadura de status — o motor é determinístico (sem `Date.now()`, sem
 *      `Math.random()`), pré-requisito de golden test;
 *   P5 a fronteira de completude — `missing` só cita caminho de campo que de
 *      fato não foi fornecido, e caminho de índice resolve para o item real.
 *
 * Mais a varredura de error-swallowing sobre `src/` (fora de `src/test/`),
 * que é o que sustenta INV-013.
 */

import { readdirSync, readFileSync } from "node:fs";
import { join, relative, sep } from "node:path";

import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";

import {
  calcIncomplete,
  calcInvalid,
  calcOk,
  calculatePriceFormation,
  calculateScenario,
  computeProduct,
  convertUnit,
  type CalculationError,
  type CalculationResult,
  type CalculationWarning,
  type FeeRow,
  type IngredientRow,
  type MissingField,
  type ProductInput,
  type ScenarioInput,
  type UnitConversionContext,
} from "@/lib/finance";

/* ------------------------------------------------------------------ *
 * Fixtures — uma entrada COMPLETA por motor, e só uma mutação por caso.
 * ------------------------------------------------------------------ */

const CENARIO_COMPLETO: ScenarioInput = {
  price: 10,
  unitCost: 3,
  taxRate: 5,
  fees: [{ percentage: 2 }],
  fixedExpenses: 1000,
  volume: 200,
  volumeSource: "manual_simulation",
};

const INGREDIENTE_COMPLETO: IngredientRow = {
  used_qty: 200,
  used_unit: "g",
  package_price: 6,
  package_qty: 1000,
  package_unit: "g",
};

const PRODUTO_COMPLETO: ProductInput = {
  ingredients: [INGREDIENTE_COMPLETO],
  packaging: [{ package_price: 3, units_per_package: 10 }],
  yieldQty: 20,
  price: 15,
  taxRate: 5,
  fees: [{ percentage: 2 }],
};

/** Cópia rasa: o teste muta UM campo por vez, sem contaminar o fixture. */
function comCampo<K extends keyof ScenarioInput>(
  base: ScenarioInput,
  key: K,
  value: ScenarioInput[K],
): ScenarioInput {
  return { ...base, [key]: value };
}

function produtoCom(mut: (base: ProductInput) => ProductInput): ProductInput {
  return mut({
    ...PRODUTO_COMPLETO,
    ingredients: PRODUTO_COMPLETO.ingredients.map((row) => ({ ...row })),
    packaging: PRODUTO_COMPLETO.packaging.map((row) => ({ ...row })),
    fees: PRODUTO_COMPLETO.fees.map((row) => ({ ...row })),
  });
}

/* ------------------------------------------------------------------ *
 * Leitores tolerantes ao Result Type: extraem o que o status garante e
 * falham com mensagem legível quando o status não é o esperado — ler a
 * union discriminada às cegas é como um `value` inventado escapa do motor.
 * ------------------------------------------------------------------ */

function errosDe(r: CalculationResult<unknown>): CalculationError[] {
  if (r.status !== "invalid") throw new Error(`esperado invalid, obtido ${r.status}`);
  return r.errors;
}

function faltantesDe(r: CalculationResult<unknown>): MissingField[] {
  if (r.status !== "incomplete") throw new Error(`esperado incomplete, obtido ${r.status}`);
  return r.missing;
}

function valorDe<T>(r: CalculationResult<T>): T {
  if (r.status !== "ok") throw new Error(`esperado ok, obtido ${r.status}`);
  return r.value;
}

function avisosDe(r: CalculationResult<unknown>): CalculationWarning[] {
  if (r.status === "invalid") throw new Error("`invalid` não transporta warnings");
  return r.warnings;
}

describe("P1 — `incomplete` nunca é convertido em `ok` com valor inventado", () => {
  it("o fixture completo é `ok` (o par é falsificável: a mutação abaixo muda o status)", () => {
    const r = calculateScenario(CENARIO_COMPLETO);
    expect(r.status).toBe("ok");
    expect(valorDe(r).revenue).toBe(2000);
  });

  it.each([
    ["price", null],
    ["unitCost", null],
    ["taxRate", null],
    ["fixedExpenses", null],
    ["volume", null],
  ] as const)(
    "ausência em %s devolve `incomplete`, nunca `ok` com valor inventado",
    (campo, valor) => {
      const r = calculateScenario(comCampo(CENARIO_COMPLETO, campo, valor));
      expect(r.status).toBe("incomplete");
      // `value` não existe no ramo `incomplete`: se alguém "resolvesse" a
      // ausência com 0, a chave apareceria aqui e o teste reprovaria.
      expect("value" in r).toBe(false);
      expect(faltantesDe(r).map((m) => m.field)).toContain(campo);
    },
  );

  it("ausência na taxa de uma fee cita o item real (`fees[0].percentage`)", () => {
    const r = calculateScenario(comCampo(CENARIO_COMPLETO, "fees", [{ percentage: null }]));
    expect(faltantesDe(r)).toEqual([{ field: "fees[0].percentage" }]);
  });

  it("ausência de rendimento torna o custo direto incompleto, não zero", () => {
    const r = computeProduct(produtoCom((p) => ({ ...p, yieldQty: null })));
    expect(faltantesDe(r)).toEqual([{ field: "yieldQty" }]);
    expect("value" in r).toBe(false);
  });

  it("`ok` nunca carrega `missing`, e `incomplete` nunca carrega `value`", () => {
    const ok = calculateScenario(CENARIO_COMPLETO);
    expect("missing" in ok).toBe(false);
    const incomplete = calculateScenario(comCampo(CENARIO_COMPLETO, "price", null));

    expect("value" in incomplete).toBe(false);
    expect("errors" in incomplete).toBe(false);
  });
});

describe("P2 — `invalid` nunca é rebaixado a `incomplete`", () => {
  it.each([
    ["NaN", Number.NaN],
    ["-1 abaixo do mínimo", -1],
    ["Infinity", Number.POSITIVE_INFINITY],
  ])("preço %s é `invalid` e não `incomplete`", (_rotulo, preco) => {
    const r = calculateScenario(comCampo(CENARIO_COMPLETO, "price", preco));
    expect(r.status).toBe("invalid");
    expect(errosDe(r).map((e) => e.field)).toContain("price");
    // A distinção é load-bearing: rebaixar para `incomplete` faria a UI pedir
    // "informe o preço" quando o preço informado é inaproveitável.
    expect("missing" in r).toBe(false);
  });

  it("precedência: erro PRESENTE vence ausência — o par nunca vira `incomplete`", () => {
    const r = calculateScenario({
      ...CENARIO_COMPLETO,
      price: Number.NaN, // inválido
      unitCost: null, // ausente
      taxRate: null, // ausente
    });
    expect(r.status).toBe("invalid");
    expect(errosDe(r).map((e) => e.field)).toEqual(["price"]);
    expect("missing" in r).toBe(false);
  });

  it("volume numérico com origem `unknown` é `invalid`, não `incomplete`", () => {
    const r = calculateScenario(comCampo(CENARIO_COMPLETO, "volumeSource", "unknown"));
    expect(r.status).toBe("invalid");
    expect(errosDe(r).map((e) => e.code)).toEqual(["INVALID_VOLUME_SOURCE"]);
  });

  it("origem de volume fora do conjunto suportado é `invalid` mesmo sem volume", () => {
    const r = calculateScenario({
      ...CENARIO_COMPLETO,
      volume: null,
      volumeSource: "inventado" as ScenarioInput["volumeSource"],
    });
    expect(r.status).toBe("invalid");
  });

  it("campo ausente NÃO entra em `missing` quando o mesmo campo tem valor inaproveitável", () => {
    // ingredients[0].package_price = NaN é ERRO (FIN-003), não ausência: a
    // fronteira de completude (P5) é consequência desta distinção.
    const r = computeProduct(
      produtoCom((p) => ({
        ...p,
        ingredients: [{ ...p.ingredients[0], package_price: Number.NaN }],
      })),
    );
    expect(r.status).toBe("invalid");
    expect(errosDe(r).map((e) => e.field)).toEqual(["ingredients[0].package_price"]);
  });

  it("`invalid` carrega só `errors` — nenhuma chave de warning ou valor", () => {
    const r = calculateScenario(comCampo(CENARIO_COMPLETO, "price", -1));
    expect(Object.keys(r).sort()).toEqual(["errors", "status"]);
  });
});

describe("P3 — `warnings` são propagadas, nunca engolidas", () => {
  const AVISO: CalculationWarning = { code: "CUSTO_PARCIAL", message: "custo parcial", field: "x" };

  it("`calcOk` propaga a lista de warnings sem filtrar nem reordenar", () => {
    const warnings = [AVISO, { code: "OUTRO", message: "segundo aviso" }];
    const r = calcOk(42, warnings);
    expect(valorDe(r)).toBe(42);
    expect(avisosDe(r)).toEqual(warnings);
  });

  it("`calcIncomplete` carrega `missing` E `warnings` — os dois convivem", () => {
    const r = calcIncomplete([{ field: "price" }], [AVISO]);
    expect(faltantesDe(r)).toEqual([{ field: "price" }]);
    expect(avisosDe(r)).toEqual([AVISO]);
  });

  it("`ok` sem warning e `ok` com warning são estruturalmente distintos (o vazio é informação)", () => {
    const semAviso = calcOk(1);
    const comAviso = calcOk(1, [AVISO]);
    expect(avisosDe(semAviso)).toEqual([]);
    expect(avisosDe(comAviso)).toEqual([AVISO]);
    expect(semAviso).not.toEqual(comAviso);
  });

  it("`calcInvalid` não transporta `warnings` — erro não é advice", () => {
    const r = calcInvalid([{ code: "INVALID_NUMBER", message: "ruim" }]);
    expect(Object.keys(r).sort()).toEqual(["errors", "status"]);
  });

  it("LIMITE DECLARADO: nenhum motor emite warning hoje — falha aqui = produtor novo, não bug", () => {
    // Se este teste falhar, algum `calcOk`/`calcIncomplete` passou a emitir
    // warning dentro do motor: então a propagação ganhou produtor e precisa de
    // caso próprio (este arquivo ainda não afirma nada sobre warnings reais).
    const r = calculateScenario(CENARIO_COMPLETO);
    expect(valorDe(r).revenue).toBe(2000);
    expect(avisosDe(r)).toEqual([]);
    expect(avisosDe(computeProduct(PRODUTO_COMPLETO))).toEqual([]);
    expect(avisosDe(calculateScenario(comCampo(CENARIO_COMPLETO, "price", null)))).toEqual([]);
  });
});

describe("P4 — fechadura de status: o motor é determinístico", () => {
  it("mesma entrada, duas chamadas, resultado idêntico (deep-equal)", () => {
    expect(calculateScenario(CENARIO_COMPLETO)).toEqual(calculateScenario(CENARIO_COMPLETO));
    expect(computeProduct(PRODUTO_COMPLETO)).toEqual(computeProduct(PRODUTO_COMPLETO));
  });

  it("o motor não lê o relógio nem a entropia durante o cálculo", () => {
    const relogio = vi.spyOn(Date, "now");
    const entropia = vi.spyOn(Math, "random");
    calculateScenario(CENARIO_COMPLETO);
    computeProduct(PRODUTO_COMPLETO);
    calculatePriceFormation({
      directUnitCost: 1,
      nonPercentageVariableUnitCost: 0.2,
      taxRate: 5,
      fees: [{ percentage: 2 }],
      targetContributionRate: 20,
      marketReference: 15,
    });
    expect(relogio).not.toHaveBeenCalled();
    expect(entropia).not.toHaveBeenCalled();
  });

  it("CONTROLE NEGATIVO: os espiões estão vivos (reprovariam se o motor chamasse)", () => {
    const relogio = vi.spyOn(Date, "now");
    const entropia = vi.spyOn(Math, "random");
    Date.now();
    Math.random();
    expect(relogio).toHaveBeenCalled();
    expect(entropia).toHaveBeenCalled();
  });

  it("propriedade: para qualquer entrada, o status e o valor não dependem da ordem de chamada", () => {
    fc.assert(
      fc.property(
        fc.tuple(
          fc.double({ min: 0, max: 1000, noNaN: true }),
          fc.double({ min: 0, max: 1000, noNaN: true }),
          fc.double({ min: 0, max: 50, noNaN: true }),
        ),
        ([price, unitCost, taxRate]) => {
          const entrada: ScenarioInput = { ...CENARIO_COMPLETO, price, unitCost, taxRate };
          const primeiro = calculateScenario(entrada);
          const segundo = calculateScenario(entrada);
          expect(segundo).toEqual(primeiro);
          expect(segundo.status).toBe(primeiro.status);
        },
      ),
      { numRuns: 300 },
    );
  });
});

/* ------------------------------------------------------------------ *
 * P5 — fronteira de completude: caminho de campo de `missing` tem de
 * resolver para algo que de fato não foi fornecido, e caminho de índice
 * para o item REAL.
 * ------------------------------------------------------------------ */

/** Resolve `a.b[0].c` / `fees[1].percentage` dentro da entrada. */
function resolverCaminho(entrada: unknown, caminho: string): { existe: boolean; valor: unknown } {
  let atual: unknown = entrada;
  const passos = caminho.match(/[A-Za-z_$][\w$]*|\[\d+\]/g) ?? [];
  for (const passo of passos) {
    if (atual == null || typeof atual !== "object") return { existe: false, valor: undefined };
    if (passo.startsWith("[")) {
      const indice = Number(passo.slice(1, -1));
      if (!Array.isArray(atual) || indice >= atual.length)
        return { existe: false, valor: undefined };
      atual = atual[indice];
      continue;
    }
    if (!(passo in (atual as Record<string, unknown>))) {
      return { existe: false, valor: undefined };
    }
    atual = (atual as Record<string, unknown>)[passo];
  }
  return { existe: true, valor: atual };
}

/** O campo citado está de fato ausente para o item que o índice aponta? */
function citadoRealmenteAusente(entrada: ProductInput, caminho: string): boolean {
  const { existe, valor } = resolverCaminho(entrada, caminho);
  if (existe) {
    if (valor == null) return true;
    if (!caminho.endsWith(".conversion_context")) return false;
    // Contexto FORNECIDO e mesmo assim não honrável: o motor não consegue
    // usá-lo. Reconfirma com a conversão real daquela LINHA — é aqui que um
    // índice trocado (off-by-one) apareceria.
    const linha = resolverCaminho(entrada, caminho.replace(/\.conversion_context$/, "")).valor;
    if (linha == null || typeof linha !== "object") return false;
    const row = linha as IngredientRow;
    return (
      convertUnit(
        row.used_qty,
        row.used_unit,
        row.package_unit ?? "",
        valor as UnitConversionContext,
      ) === null
    );
  }
  // Campo OPCIONAL de um item indexado, simplesmente não fornecido: a chave
  // nem existe na linha (`conversion_context` é `?` em `IngredientRow`), e
  // isso é ausência legítima — desde que o pai resolvido exista. Caminho órfão
  // (pai ausente) ou caminho na raiz sem a chave é erro de citação, não prova.
  if (!/\[\d+\]/.test(caminho)) return false;
  const pai = resolverCaminho(entrada, caminho.replace(/\.[A-Za-z_$][\w$]*$/, ""));
  return pai.existe && pai.valor != null && typeof pai.valor === "object";
}

describe("P5 — a fronteira de completude dos caminhos de `missing`", () => {
  it("propriedade: um único campo nulo é citado exatamente uma vez, no índice certo", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 4 }),
        fc.nat(),
        fc.constantFrom("package_price", "package_qty" as const),
        (quantidade, semente, campo) => {
          const indice = semente % quantidade;
          const base = produtoCom((p) => ({
            ...p,
            ingredients: Array.from({ length: quantidade }, () => ({ ...INGREDIENTE_COMPLETO })),
          }));
          const entrada: ProductInput = {
            ...base,
            ingredients: base.ingredients.map((row, i) =>
              i !== indice
                ? row
                : campo === "package_price"
                  ? { ...row, package_price: null }
                  : { ...row, package_qty: null },
            ),
          };
          const r = computeProduct(entrada);
          expect(faltantesDe(r)).toEqual([{ field: `ingredients[${indice}].${campo}` }]);
        },
      ),
      { numRuns: 200 },
    );
  });

  it("propriedade: taxa de fee nula cita `fees[<índice real>].percentage`", () => {
    fc.assert(
      fc.property(fc.integer({ min: 1, max: 4 }), fc.nat(), (quantidade, semente) => {
        const indice = semente % quantidade;
        const fees: FeeRow[] = Array.from({ length: quantidade }, () => ({ percentage: 2 }));
        fees[indice] = { percentage: null };
        const r = computeProduct(produtoCom((p) => ({ ...p, fees })));
        expect(faltantesDe(r)).toEqual([{ field: `fees[${indice}].percentage` }]);
      }),
      { numRuns: 200 },
    );
  });

  it("caminho de índice de `conversion_context` resolve para o item real (não off-by-one)", () => {
    // Só o ingrediente 1 exige contexto: unidade de contagem para massa. Os
    // ingredientes 0 e 2 convertem sem contexto e NÃO podem ser citados.
    const entrada: ProductInput = produtoCom((p) => ({
      ...p,
      ingredients: [
        { ...INGREDIENTE_COMPLETO, used_qty: 200, used_unit: "g" },
        { ...INGREDIENTE_COMPLETO, used_qty: 1, used_unit: "unidade" },
        { ...INGREDIENTE_COMPLETO, used_qty: 2, package_qty: 500, package_unit: "kg" },
      ],
    }));
    const r = computeProduct(entrada);
    expect(r.status).toBe("incomplete");
    const campos = faltantesDe(r).map((m) => m.field);
    expect(campos).toEqual(["ingredients[1].conversion_context"]);
    expect(entrada.ingredients[1].conversion_context).toBeUndefined();
    expect(entrada.ingredients[0].conversion_context).toBeUndefined();
    expect(entrada.ingredients[2].conversion_context).toBeUndefined();
  });

  it("todo `missing` citado aponta para folha realmente ausente na entrada", () => {
    const entrada: ProductInput = produtoCom((p) => ({
      ...p,
      ingredients: [
        { ...INGREDIENTE_COMPLETO, used_unit: "unidade" }, // falta conversion_context
        { ...INGREDIENTE_COMPLETO, package_price: null }, // falta preço
        { ...INGREDIENTE_COMPLETO },
      ],
      fees: [{ percentage: null }, { percentage: 2 }],
      yieldQty: null,
    }));
    const r = computeProduct(entrada);
    expect(r.status).toBe("incomplete");
    const campos = faltantesDe(r).map((m) => m.field);
    // Três defeitos em itens diferentes: o caminho tem de distinguir todos.
    expect(campos).toEqual(
      expect.arrayContaining([
        "ingredients[0].conversion_context",
        "ingredients[1].package_price",
        "fees[0].percentage",
        "yieldQty",
      ]),
    );
    for (const campo of campos) {
      expect(citadoRealmenteAusente(entrada, campo)).toBe(true);
    }
  });

  it("curto-circuito por linha PINADO: `package_unit` nulo oculta o `conversion_context`", () => {
    // `collectProductCostIssues` (src/lib/finance.ts) retorna da linha logo
    // após `package_unit == null`: sem unidade de embalagem, "confirme o fator
    // de conversão" é ruído. Os campos numéricos da MESMA linha são coletados
    // ANTES do atalho e por isso continuam aparecendo — comportamento
    // deliberado, aqui pinado para não virar acidente.
    const entrada: ProductInput = produtoCom((p) => ({
      ...p,
      ingredients: [
        {
          ...INGREDIENTE_COMPLETO,
          used_unit: "unidade",
          package_unit: null,
          package_qty: null,
        },
      ],
    }));
    const r = computeProduct(entrada);
    expect(faltantesDe(r)).toEqual([
      { field: "ingredients[0].package_qty" },
      { field: "ingredients[0].package_unit" },
    ]);
  });

  it("CONTROLE NEGATIVO: o resolvedor de caminho rejeita caminho órfão", () => {
    expect(citadoRealmenteAusente(PRODUTO_COMPLETO, "ingredients[7].package_price")).toBe(false);
    expect(citadoRealmenteAusente(PRODUTO_COMPLETO, "campoQueNaoExiste")).toBe(false);
    expect(citadoRealmenteAusente(PRODUTO_COMPLETO, "ingredients[0].package_price")).toBe(false);
  });
});

/* ------------------------------------------------------------------ *
 * Varredura de error-swallowing (INV-013).
 *
 * NÚCLEO PURO: `auditarEngolimento(arquivos)` recebe fontes já lidas e devolve
 * achados. O I/O (listar `src/`) fica no teste. Sem essa separação o controle
 * negativo não seria hermético: para falsificar a detecção seria preciso
 * mutar a árvore do repo.
 * ------------------------------------------------------------------ */

export type CamadaAchado = "silencioso" | "sucesso-vazio" | "tradutor";

export interface Achado {
  caminho: string;
  linha: number;
  camada: CamadaAchado;
  motivo: string;
  assinatura: string;
}

/** Chamadas que REGISTRAM o erro (INV-013 exige sinalizar, não sumir). */
const REGISTRA =
  /\b(console\.(?:log|warn|error|info|debug)|logJson|logError|recordSafely|\brecord\(|captureException|captureError|reportError|addBreadcrumb|increment|toast\b)/;

/** Valores que fazem um erro parecer sucesso vazio. */
const NEUTRO = /^(?:null|undefined|\[\]|\{\}|""|''|0|false)$/;

/**
 * O corpo do `catch` devolve SÓ valores neutros? É esta a fronteira entre
 * "sucesso vazio" (erro disfarçado de nada) e "tradutor" (erro disfarçado de
 * sinal explícito, como `NaN` ou `{status:"invalid"}`).
 */
function devolveNeutro(corpo: string): boolean {
  const retornos = [...corpo.matchAll(/\breturn\b\s*([^;]*);?/g)].map((m) => m[1].trim());
  if (retornos.length === 0) return false;
  return retornos.every((valor) => valor === "" || NEUTRO.test(valor));
}

function semComentarios(fonte: string): string {
  return fonte.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

function cabecaNormalizada(corpo: string): string {
  const primeira = corpo.split("\n").find((linha) => linha.trim() !== "") ?? "";
  const limpa = primeira.trim().replace(/\s+/g, " ");
  return limpa.length > 0 ? limpa.slice(0, 80) : "<vazio>";
}

/** Encontra o fechamento correspondente abrindo em `inicio`. */
function fimDoBloco(fonte: string, inicio: number, abre: string, fecha: string): number {
  let profundidade = 0;
  for (let i = inicio; i < fonte.length; i++) {
    if (fonte[i] === abre) profundidade++;
    else if (fonte[i] === fecha) {
      profundidade--;
      if (profundidade === 0) return i;
    }
  }
  return -1;
}

/**
 * Varre as fontes e classifica todo `catch` que não propaga (`throw`) nem
 * registra (chamada de log/métrica).
 *
 * CAMADAS:
 *   `silencioso`    — corpo vazio depois de remover comentários: nada acontece.
 *   `sucesso-vazio` — converte a falha em valor neutro (`null`, `[]`, `{}`,
 *                      `""`, `0`, `false`). É a forma do INV-013.
 *   `tradutor`      — converte a falha em sinal explícito (`NaN`,
 *                      `{status:"invalid"}`, `rejected(...)`): ruído para esta
 *                      varredura, mas CONTADO para provar que o parser viu o site.
 *
 * Descoberta vazia é violação: 0 arquivos recebidos significa que a varredura
 * quebrou, não que o repositório está limpo.
 */
export function auditarEngolimento(arquivos: { caminho: string; fonte: string }[]): Achado[] {
  const achados: Achado[] = [];
  if (arquivos.length === 0) {
    return [
      {
        caminho: "<varredura>",
        linha: 0,
        camada: "silencioso",
        motivo: "descoberta vazia: nenhum arquivo lido — o parser quebrou, não o repo está limpo",
        assinatura: "<vazio>",
      },
    ];
  }

  for (const { caminho, fonte } of arquivos) {
    // `catch (e) {` / `} catch {` — a âncora é a palavra, não a chave de
    // fechamento, para não perder `try { ... } catch`.
    const bloco = /catch\s*(?:\(([^)]*)\))?\s*\{/g;
    let casamento: RegExpExecArray | null;
    while ((casamento = bloco.exec(fonte)) !== null) {
      const abre = fonte.indexOf("{", casamento.index);
      const fecha = fimDoBloco(fonte, abre, "{", "}");
      if (fecha === -1) continue;
      const corpo = semComentarios(fonte.slice(abre + 1, fecha)).trim();
      const linha = fonte.slice(0, casamento.index).split("\n").length;
      const propaga = /\bthrow\b/.test(corpo);
      const registra = REGISTRA.test(corpo);
      if (propaga || registra) continue;

      if (corpo === "") {
        achados.push({
          caminho,
          linha,
          camada: "silencioso",
          motivo: "corpo vazio: não propaga, não registra e não devolve nada",
          assinatura: "<vazio>",
        });
        continue;
      }
      const neutro = devolveNeutro(corpo);
      achados.push({
        caminho,
        linha,
        camada: neutro ? "sucesso-vazio" : "tradutor",
        motivo: neutro
          ? "converte a falha em valor neutro (sucesso vazio)"
          : "converte a falha em sinal explícito, sem propagar nem registrar",
        assinatura: cabecaNormalizada(corpo),
      });
    }

    // `.catch(cb)` — sem bloco, mas ainda é um engolimento quando o callback
    // devolve valor neutro. Callback nomeado é propagação indeterminada: não
    // entra no inventário, e a limitação está declarada na evidência.
    const promessa = /\.catch\s*\(/g;
    while ((casamento = promessa.exec(fonte)) !== null) {
      const abre = casamento.index + casamento[0].length - 1;
      const fecha = fimDoBloco(fonte, abre, "(", ")");
      if (fecha === -1) continue;
      const corpo = semComentarios(fonte.slice(abre + 1, fecha)).trim();
      const callback = /^\(?\s*(?:async\s+)?(?:\(\s*\))?\s*=>\s*([\s\S]*)$/.exec(corpo);
      if (callback === null) continue;
      const devolvido = callback[1].trim();
      if (REGISTRA.test(devolvido)) continue;
      const neutro = devolvido === "undefined" || NEUTRO.test(devolvido);
      achados.push({
        caminho,
        linha: fonte.slice(0, casamento.index).split("\n").length,
        camada: neutro ? "sucesso-vazio" : "tradutor",
        motivo: neutro
          ? "callback de `.catch` devolve valor neutro"
          : "callback de `.catch` trata a falha sem propagar nem registrar",
        assinatura: `.catch(=> ${cabecaNormalizada(devolvido)})`,
      });
    }
  }
  return achados;
}

/** Caminhos onde falha de dado tem de SUBIR (INV-013). */
const CAMINHO_DE_DADO =
  /^(src\/server\/|src\/routes\/api\/|src\/lib\/[^/]*\.(?:server|functions)\.ts$)/;

/** Fingerprint estável: arquivo|camada|assinatura (sem linha — deriva é ruído). */
function digital(a: Achado): string {
  return `${a.caminho}|${a.camada}|${a.assinatura}`;
}

function arvoreDeFontes(raiz: string): { caminho: string; fonte: string }[] {
  const arquivos: { caminho: string; fonte: string }[] = [];
  const andar = (dir: string): void => {
    for (const entrada of readdirSync(dir, { withFileTypes: true })) {
      const cheio = join(dir, entrada.name);
      if (entrada.isDirectory()) {
        if (entrada.name === "test" && dir.endsWith(`${sep}src`)) continue;
        andar(cheio);
        continue;
      }
      if (!/\.tsx?$/.test(entrada.name)) continue;
      const caminho = relative(raiz, cheio).split(sep).join("/");
      arquivos.push({ caminho, fonte: readFileSync(cheio, "utf8") });
    }
  };
  andar(join(raiz, "src"));
  return arquivos;
}

describe("varredura de catch / error-swallowing sobre `src/` (INV-013)", () => {
  const RAIZ = process.cwd();
  const ARQUIVOS = arvoreDeFontes(RAIZ);
  const ACHADOS = auditarEngolimento(ARQUIVOS);
  const DIGITAIS = ACHADOS.map(digital).sort();
  const porCamada = (camada: CamadaAchado): Achado[] => ACHADOS.filter((a) => a.camada === camada);

  it("a varredura é viva: leu a árvore real e encontrou sites de `catch`", () => {
    expect(ARQUIVOS.length).toBeGreaterThan(100);
    const comCatch = ARQUIVOS.filter((a) => /catch/.test(a.fonte));
    expect(comCatch.length).toBeGreaterThan(20);
    // Descoberta zerada é falha do parser, nunca "repo limpo".
    expect(auditarEngolimento([])).toHaveLength(1);
    expect(auditarEngolimento([])[0].motivo).toContain("descoberta vazia");
  });

  it("INV-013: nenhum `catch` SILENCIOSO em caminho de dado de servidor", () => {
    // Invariante dura e hoje verdadeira: em `src/server/**`, `src/routes/api/**`
    // e `src/lib/**.{server,functions}.ts` não pode existir catch que não
    // propaga, não registra e não devolve nada. Ache novo aqui REPROVA.
    expect(
      ACHADOS.filter((a) => a.camada === "silencioso" && CAMINHO_DE_DADO.test(a.caminho)).map(
        (a) => `${a.caminho}:${a.linha}`,
      ),
    ).toEqual([]);
  });

  it("sucesso vazio em caminho de dado: lista DECLARADA, não verde silencioso", () => {
    // Estes sites convertem exceção em valor neutro. A análise arquivo a
    // arquivo está em docs/evidence/finance-result-invariants.md: a lista
    // abaixo é a dívida proposta, verificada por execução — sumir dela também
    // reprova também, porque significaria mudança de comportamento sem decisão.
    expect(
      ACHADOS.filter((a) => a.camada === "sucesso-vazio" && CAMINHO_DE_DADO.test(a.caminho)).map(
        (a) => `${a.caminho}|${a.assinatura}`,
      ),
    ).toEqual(SUCESSO_VAZIO_EM_DADO);
  });

  it("o inventário medido de achados é o declarado — achado novo REPROVA", () => {
    // Pinos por `arquivo|camada|assinatura`, sem linha: derivar de linha não é
    // dívida nova. Mudar este inventário é um ato consciente, com justificativa
    // em docs/evidence/finance-result-invariants.md.
    expect(DIGITAIS).toEqual(INVENTARIO_MEDIDO);
  });

  it("contagem por camada permanece a medida (o tradutor nunca pode sumir em silêncio)", () => {
    expect(porCamada("silencioso").length).toBe(CONTAGENS.silencioso);
    expect(porCamada("sucesso-vazio").length).toBe(CONTAGENS["sucesso-vazio"]);
    expect(porCamada("tradutor").length).toBe(CONTAGENS.tradutor);
    expect(CONTAGENS.silencioso + CONTAGENS["sucesso-vazio"] + CONTAGENS.tradutor).toBe(
      ACHADOS.length,
    );
  });
});

describe("auditarEngolimento — controles negativos (a detecção falsifica de verdade)", () => {
  const fonte = (corpo: string): { caminho: string; fonte: string }[] => [
    {
      caminho: "src/exemplo.ts",
      fonte: `export function f() {\n  try {\n    g();\n  } ${corpo}\n}\n`,
    },
  ];

  it("CONTROLE NEGATIVO: `catch {}` vazio é achado `silencioso`", () => {
    const achados = auditarEngolimento(fonte("catch {}"));
    expect(achados).toHaveLength(1);
    expect(achados[0].camada).toBe("silencioso");
    expect(achados[0].linha).toBe(4);
  });

  it("CONTROLE NEGATIVO: catch só com comentário continua `silencioso` (comentário não corrige)", () => {
    const achados = auditarEngolimento(fonte("catch {\n    // engolido de propósito\n  }"));
    expect(achados.map((a) => a.camada)).toEqual(["silencioso"]);
  });

  it.each([
    ["return [];", "return [];"],
    ["return {};", "return {};"],
    ["return null;", "return null;"],
    ["return 0;", "return 0;"],
    ["return false;", "return false;"],
  ])("CONTROLE NEGATIVO: `catch { %s }` é `sucesso-vazio`", (_rotulo, corpo) => {
    const achados = auditarEngolimento(fonte(`catch (e) { ${corpo} }`));
    expect(achados.map((a) => a.camada)).toEqual(["sucesso-vazio"]);
  });

  it("CONTROLE NEGATIVO: `.catch(() => null)` é `sucesso-vazio`", () => {
    const achados = auditarEngolimento([
      { caminho: "src/exemplo.ts", fonte: "p().catch(() => null);\n" },
    ]);
    expect(achados.map((a) => a.camada)).toEqual(["sucesso-vazio"]);
    expect(achados[0].assinatura).toBe(".catch(=> null)");
  });

  it("CONTROLE POSITIVO: `catch` que relança NÃO é achado", () => {
    expect(auditarEngolimento(fonte("catch (e) { throw e; }"))).toEqual([]);
  });

  it("CONTROLE POSITIVO: `catch` que registra NÃO é achado", () => {
    expect(auditarEngolimento(fonte('catch (e) { logJson("error", "falhou", { e }); }'))).toEqual(
      [],
    );
  });

  it("CONTROLE POSITIVO: `catch` que traduz para sinal explícito NÃO é `sucesso-vazio`", () => {
    const achados = auditarEngolimento(fonte('catch { return { status: "invalid" }; }'));
    expect(achados.map((a) => a.camada)).toEqual(["tradutor"]);
  });

  it("CONTROLE NEGATIVO: feeds diferentes no mesmo arquivo são distintos", () => {
    const achados = auditarEngolimento([
      {
        caminho: "src/exemplo.ts",
        fonte: "try { a(); } catch {}\ntry { b(); } catch (e) { return null; }\n",
      },
    ]);
    expect(achados.map((a) => a.camada)).toEqual(["silencioso", "sucesso-vazio"]);
  });
});

/* ------------------------------------------------------------------ *
 * Inventário medido (ver `docs/evidence/finance-result-invariants.md`).
 * Preenchido por execução, não por estimativa.
 * ------------------------------------------------------------------ */

const INVENTARIO_MEDIDO: string[] = [
  "src/instrumentation/safe-record.ts|silencioso|<vazio>",
  "src/instrumentation/telemetry.ts|silencioso|<vazio>",
  "src/instrumentation/telemetry.ts|silencioso|<vazio>",
  "src/instrumentation/telemetry.ts|silencioso|<vazio>",
  "src/lib/ai/budget-ledger.server.ts|tradutor|parsed = null;",
  'src/lib/ai/budget-ledger.server.ts|tradutor|return { cost: null, status: "invalid" };',
  "src/lib/ai/tool-runner.ts|tradutor|const hash = inputHash(rawArguments);",
  "src/lib/break-even.ts|tradutor|errors.push(error as BreakEvenServiceError);",
  'src/lib/break-even.ts|tradutor|return invalidResult(input, [serializationError("fixedExpenses", error)]);',
  'src/lib/break-even.ts|tradutor|return invalidUnits(unitMode, [serializationError("rawUnits", error)]);',
  "src/lib/break-even.ts|tradutor|return {",
  "src/lib/break-even.ts|tradutor|return {",
  "src/lib/break-even.ts|tradutor|return { errors: [error as BreakEvenServiceError] };",
  'src/lib/break-even.ts|tradutor|return { value: null, error: serializationError("revenue", error) };',
  'src/lib/csp-report-payload.ts|tradutor|return { ok: false, reason: "invalid_json" };',
  'src/lib/error-capture.ts|tradutor|return String(redactLogValue(String(value), "error"));',
  "src/lib/finance.ts|tradutor|return Number.NaN;",
  "src/lib/financial-values.ts|sucesso-vazio|return false;",
  'src/lib/format.ts|sucesso-vazio|return "";',
  "src/lib/format.ts|tradutor|return Number.NaN;",
  "src/lib/sales.functions.ts|tradutor|validateBusinessError(error);",
  "src/lib/web-vitals.client.ts|sucesso-vazio|.catch(=> undefined)",
  "src/lib/web-vitals.client.ts|sucesso-vazio|.catch(=> undefined)",
  "src/routes/_authenticated/despesas.tsx|sucesso-vazio|.catch(=> null)",
  "src/routes/_authenticated/inicio.tsx|sucesso-vazio|.catch(=> null)",
  "src/routes/_authenticated/ponto-equilibrio.tsx|sucesso-vazio|.catch(=> null)",
  "src/routes/_authenticated/ponto-equilibrio.tsx|sucesso-vazio|.catch(=> null)",
  'src/routes/api/csp-report.ts|tradutor|return rejected("unexpected_error", error);',
  'src/routes/api/vitals.ts|tradutor|return rejected("invalid_json");',
  "src/server.ts|sucesso-vazio|return false;",
  "src/server/auth/auth-policy.ts|tradutor|failure = policyMessage(error);",
  'src/server/auth/auth-policy.ts|tradutor|return { ...entry, verdict: "invalid", detail: policyMessage(error) };',
  'src/server/auth/auth-policy.ts|tradutor|return { ...entry, verdict: "invalid", detail: policyMessage(error) };',
  'src/server/auth/auth-policy.ts|tradutor|return { ...entry, verdict: "invalid", detail: policyMessage(error) };',
  "src/server/services/dashboard.service.ts|tradutor|fixedExpenseSummary.invalid = true;",
  "src/server/services/dashboard.service.ts|tradutor|invalid = true;",
  'src/server/services/dashboard.service.ts|tradutor|return { status: "invalid" };',
  "src/server/services/diagnostic.service.ts|tradutor|invalid = true;",
  "src/server/services/financial.service.ts|tradutor|return Number.NaN;",
  "src/server/services/outbox.worker.ts|tradutor|result.failed += 1;",
  "src/start.ts|tradutor|if (error instanceof Response) {",
];

const CONTAGENS = { silencioso: 4, "sucesso-vazio": 9, tradutor: 28 };

/**
 * Sucesso vazio em caminho de dado de servidor — hoje **ZERO**, por decisão.
 *
 * Até o ciclo 3 esta lista continha `src/server/auth/password.server.ts|return false;`:
 * o `catch` do verifier convertia exceção em `false`. A dívida foi registrada como
 * **DBT-26** e o MAESTRO autorizou a correção (classe `robustez`, severidade `média`;
 * o veredito `P0`/`DatabaseError` do brief foi medido falso — `verifyPassword` é
 * cripto pura e não acessa banco). O site sumiu porque o comportamento mudou **com
 * decisão registrada**, que é exatamente o que este registry exige para aceitar uma
 * remoção; a lista fica vazia e passa a afirmar que não há mais nenhum `sucesso-vazio`
 * em caminho de dado. A análise arquivo a arquivo está em
 * `docs/evidence/finance-result-invariants.md` §3.1.
 *
 * Os controles negativos desta suíte (linhas ~767-776) continuam fabricando achados
 * em fixture, então o scanner segue provado vivo — esvaziar a lista não desliga a
 * detecção.
 */
const SUCESSO_VAZIO_EM_DADO: string[] = [];
