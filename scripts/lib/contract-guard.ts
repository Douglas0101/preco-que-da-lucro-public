/**
 * contract-guard — guarda fail-closed dos contratos de borda (Fase C).
 *
 * Existe por causa de um vazio medido, não por especulação: as server functions
 * deste repo **têm contrato de entrada e não têm contrato de saída**. Nenhuma
 * das funções declaradas em `src/lib/*.functions.ts` publica `outputSchema`,
 * `responseSchema` ou `.returns(`. Trocar `zod` ou `@tanstack/react-start` muda o
 * que `.validator((input) => schema.parse(input))` faz com uma entrada hostil,
 * e nada no repositório segura esse contrato por asserção de estrutura.
 *
 * A convenção que este guard **descobre** (e não impõe) é a real: o schema Zod
 * é declarado **inline, no arquivo da própria server function**
 * (`src/lib/products.functions.ts:355`, `src/lib/products.functions.ts:446`).
 * Não existe — e não deve passar a existir — um diretório paralelo de
 * contratos: duas convenções de contrato divergem sozinhas, que é exatamente o
 * que `UPGRADE-POLICY.md` já registrou para as faixas de versão.
 *
 * Regra de decisão que evita o alarme falso (a parte que importa):
 * **uma função só é violação por entrada não validada se recebe entrada.** Um
 * `createServerFn({ method: "GET" })` sem parâmetro e sem validator é
 * legítimo — `listProducts` (`src/lib/products.functions.ts:339`) e
 * `listSimulations` (`src/lib/financial.functions.ts:47`) são exatamente isso.
 * Exigir validator ali seria falso positivo, e guarda que alarma sem motivo
 * treina o time a ignorar a guarda. Se o parser **não** consegue determinar o
 * parâmetro com segurança, o resultado é **precondição (exit 2)**, nunca `pass`:
 * parser que adivinha é parser que aprova hole.
 *
 * Contratos de saída são **medidos e reportados**, não fechados. Retipar todas
 * as funções declaradas é refatoração de outro ciclo e decisão do MAESTRO;
 * esconder o zero seria cobertura aparente, o pior resultado possível e um
 * defeito que este repositório já tem precedente documentado de punir (DBT-19).
 *
 * Divisão núcleo/I/O (deliberada, igual à de `migration-toolchain-guard.ts`):
 *   - núcleo puro: `auditContractCompliance(input)` / `evaluateContractGuard(input)`
 *     recebem **dados já lidos**, não tocam `fs` e devolvem findings/checks —
 *     é isso que torna os controles negativos herméticos, sem segundo
 *     `node_modules` e sem banco;
 *   - CLI: todo o I/O mora em `collectContractInput` + `main`.
 *
 * Códigos de saída: 0 = pass · 1 = veredito (violação) · 2 = precondição
 * (arquivo ausente, ilegível, ou parâmetro indeterminável). Precondição nunca
 * é `pass`. Mesma convenção de `scripts/m02-lockfile-guard.mjs`.
 *
 * Formato da finding (contrato compartilhado com os demais guards):
 *   `${sujeito} (${lado}): observado ${observado}, esperado ${esperado}`
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

// ---------------------------------------------------------------------------
// Contrato do plano §6.9
// ---------------------------------------------------------------------------

/**
 * Os nove códigos que o plano §6.9 exige. Esta lista é a **fonte da verdade do
 * guard**; o que `api-error.ts` declara é **lido do arquivo**, nunca espelhado
 * numa cópia local. O que o guard faz é comparar as duas pontas e dizer o que
 * falta — a lista parallelizada é o defeito, não o conserto.
 */
export const REQUIRED_ERROR_CODES = [
  "VALIDATION_ERROR",
  "AUTHENTICATION_ERROR",
  "AUTHORIZATION_ERROR",
  "NOT_FOUND",
  "CONFLICT",
  "DATABASE_ERROR",
  "DEPENDENCY_ERROR",
  "AI_TIMEOUT",
  "AI_QUOTA",
] as const;

export type RequiredErrorCode = (typeof REQUIRED_ERROR_CODES)[number];

/** Superfície de servidor functions — a fronteira BFF. */
const FUNCTIONS_DIR = path.join("src", "lib");
const FUNCTIONS_SUFFIX = ".functions.ts";
const API_ERROR_FILE = path.join("src", "lib", "api-error.ts");
const TOOL_REGISTRY_FILE = path.join("src", "lib", "ai", "tool-registry.ts");

/** Doc que registra o limite de contrato de saída e como fechá-lo. */
const POLICY_DOC = "docs/upgrades/CONTRACT-POLICY.md";
const BASELINE_FILE = "scripts/contract-baseline.json";

// ---------------------------------------------------------------------------
// Descoberta (pura) — o parser que decide entrada vs. ausência de entrada
// ---------------------------------------------------------------------------

/**
 * Declaração de server function. O padrão do repositório é
 * `export const nome = createServerFn({ method: "POST" })` na linha inteira: o
 * compilador do TanStack exige que cada `createServerFn` seja atribuído a uma
 * variável de topo de módulo (`src/lib/products.functions.ts:539`), então
 * ancorar a regex na linha não perde declaração nenhuma.
 */
const DECLARATION_RE =
  /^[ \t]*export[ \t]+const[ \t]+([A-Za-z0-9_$]+)[ \t]*=[ \t]*createServerFn\((.*)$/;
const METHOD_RE = /method[ \t]*:[ \t]*"(GET|POST)"/;
const HANDLER_CALL_RE = /\.handler\(/;
const HANDLER_PARAMS_RE = /\.handler\(\s*async\s*\(\s*\{([^}]*)\}/;
const VALIDATOR_RE = /\.validator\(/;
const VALIDATOR_OPEN = ".validator(";
const SCHEMA_CALL_RE = /\b([A-Za-z_$][\w$]*)\s*\.\s*(?:safeParse|parse)\s*\(/;
const INLINE_ZOD_RE = /\bz\s*\.\s*[A-Za-z]/;
const OUTPUT_CONTRACT_RE = /\boutputSchema\b|\bresponseSchema\b|\.\s*returns\s*\(/;

export interface SourceFile {
  /** Caminho relativo à raiz do repositório. */
  file: string;
  text: string;
}

/**
 * `true` recebe entrada · `false` não recebe entrada · **`null` indeterminável**.
 * `null` é precondição, nunca aprovação: o guard não sabe, e "não sei" não é
 * "está bem".
 */
export type ReceivesInput = boolean | null;

export interface ServerFunctionDecl {
  file: string;
  /** 1-based, como o editor mostra. */
  line: number;
  name: string;
  method: "GET" | "POST" | null;
  hasValidator: boolean;
  /** Nome do schema no validator, ou `null` quando não identificável. */
  schemaName: string | null;
  receivesInput: ReceivesInput;
  hasOutputContract: boolean;
}

/** Extrai o nome do schema de dentro do segmento `.validator(...)`. */
function validatorSchemaName(validatorText: string): string | null {
  const named = SCHEMA_CALL_RE.exec(validatorText);
  if (named) return named[1];
  if (INLINE_ZOD_RE.test(validatorText)) return "z.*";
  return null;
}

/**
 * Varre `src/lib/*.functions.ts` e devolve uma declaração por server function.
 *
 * O bloco de uma função vai da sua linha de declaração até a linha da próxima
 * declaração do mesmo arquivo (ou EOF). A cadeia do builder — onde `.middleware`
 * e `.validator` vivem — é tudo o que vem **antes** da linha do `.handler(`.
 */
export function discoverServerFunctions(sources: readonly SourceFile[]): ServerFunctionDecl[] {
  const found: ServerFunctionDecl[] = [];
  for (const source of sources) {
    const lines = source.text.split("\n");
    const declarations: Array<{ line: number; name: string; tail: string }> = [];
    lines.forEach((line, index) => {
      const m = DECLARATION_RE.exec(line);
      if (m) declarations.push({ line: index, name: m[1], tail: m[2] });
    });

    for (let i = 0; i < declarations.length; i += 1) {
      const decl = declarations[i];
      const end = declarations[i + 1]?.line ?? lines.length;
      const handlerOffset = lines
        .slice(decl.line, end)
        .findIndex((line) => HANDLER_CALL_RE.test(line));
      const chainText = lines
        .slice(decl.line, handlerOffset === -1 ? end : decl.line + handlerOffset)
        .join("\n");
      const hasValidator = VALIDATOR_RE.test(chainText);
      const validatorAt = chainText.indexOf(VALIDATOR_OPEN);
      const validatorText = hasValidator && validatorAt >= 0 ? chainText.slice(validatorAt) : "";
      const paramsMatch =
        handlerOffset === -1 ? null : HANDLER_PARAMS_RE.exec(lines[decl.line + handlerOffset]);
      const params = paramsMatch
        ? paramsMatch[1]
            .split(",")
            .map((p) => p.trim())
            .filter(Boolean)
        : [];

      // Sem `.handler(` ou sem destructuring reconhecível, o parâmetro é
      // indeterminável: precondição, não aprovação.
      const receivesInput: ReceivesInput =
        handlerOffset === -1 || !paramsMatch ? null : hasValidator || params.includes("data");

      found.push({
        file: source.file,
        line: decl.line + 1,
        name: decl.name,
        method: (METHOD_RE.exec(decl.tail)?.[1] as "GET" | "POST" | undefined) ?? null,
        hasValidator,
        schemaName: hasValidator ? validatorSchemaName(validatorText) : null,
        receivesInput,
        hasOutputContract: OUTPUT_CONTRACT_RE.test(lines.slice(decl.line, end).join("\n")),
      });
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Descoberta das tools de IA (pura)
// ---------------------------------------------------------------------------

const TOOL_DECL_RE = /defineTool\(\s*\{/g;
const TOOL_NAME_RE = /\bname\s*:\s*"([^"]+)"/;
const TOOL_SCHEMA_RE = /\bschema\s*:/;

export interface AiToolDecl {
  name: string;
  line: number;
  hasSchema: boolean;
}

/**
 * Varre o `DEFINITIONS` do registry. Cada tool é o objeto literal passado a
 * `defineTool({...})`; o schema é o campo `schema:` desse objeto. A assinatura
 * do wrapper (`schema: TSchema`) fica de fora de propósito: o que interessa é
 * se a **tool declarada** carrega contrato de entrada.
 */
export function discoverAiTools(text: string): AiToolDecl[] {
  const opens: number[] = [];
  for (let m = TOOL_DECL_RE.exec(text); m; m = TOOL_DECL_RE.exec(text)) opens.push(m.index);
  return opens.map((start, i) => {
    const block = text.slice(start, opens[i + 1] ?? text.length);
    return {
      name: TOOL_NAME_RE.exec(block)?.[1] ?? "(tool sem nome)",
      line: text.slice(0, start).split("\n").length,
      hasSchema: TOOL_SCHEMA_RE.test(block),
    };
  });
}

/** Códigos declarados em `API_ERROR_CODES`, lidos do arquivo. */
export function extractErrorCodes(text: string): string[] {
  const block = /API_ERROR_CODES\s*=\s*\[([\s\S]*?)\]/.exec(text);
  if (!block) return [];
  return [...block[1].matchAll(/"([A-Z][A-Z_]*)"/g)].map((m) => m[1]);
}

// ---------------------------------------------------------------------------
// Núcleo puro
// ---------------------------------------------------------------------------

export interface ContractGuardInput {
  /** Raiz do repositório — só ecoada no relatório. */
  repo: string;
  /** Arquivos `src/lib/*.functions.ts` efetivamente lidos. */
  scannedFiles: string[];
  functions: ServerFunctionDecl[];
  /** Conteúdo de `src/lib/api-error.ts`, ou `null` quando ilegível/ausente. */
  apiErrorText: string | null;
  aiTools: AiToolDecl[];
  /** Conteúdo de `src/lib/ai/tool-registry.ts`, ou `null`. */
  toolRegistryText: string | null;
  /** Piso declarado, já parseado, ou `null` quando ausente/malformado. */
  baseline: ContractBaseline | null;
}

/** Piso declarado da dívida de contrato de saída (ver `BASELINE_FILE`). */
export interface ContractBaseline {
  outputContracts: number;
  serverFunctions: number;
  debt: string;
}

/** Lado da finding — também é a chave de agrupamento dos `checks`. */
const SIDE = {
  discovery: "descoberta",
  input: "entrada",
  schema: "schema",
  taxonomy: "taxonomia",
  aiTools: "tools-ia",
  output: "saída",
} as const;

type Side = (typeof SIDE)[keyof typeof SIDE];

/** `id` de cada check, na ordem em que sai no relatório. */
const CHECK_ID: Record<Side, string> = {
  [SIDE.discovery]: "contract-discovery",
  [SIDE.input]: "contract-input-validated",
  [SIDE.schema]: "contract-schema-declared",
  [SIDE.taxonomy]: "contract-error-taxonomy",
  [SIDE.aiTools]: "contract-ai-tool-validation",
  [SIDE.output]: "contract-output-ratchet",
};

const CHECK_ORDER: readonly Side[] = [
  SIDE.discovery,
  SIDE.input,
  SIDE.schema,
  SIDE.taxonomy,
  SIDE.aiTools,
  SIDE.output,
];

interface RawFinding {
  side: Side;
  text: string;
}

const finding = (subject: string, side: Side, observed: string, expected: string): RawFinding => ({
  side,
  text: `${subject} (${side}): observado ${observed}, esperado ${expected}`,
});

/**
 * Auditoria fail-closed. Ausência é violação em ambas as direções: zero funções
 * descobertas é parser quebrado, não árvore limpa.
 */
function collectFindings(input: ContractGuardInput): RawFinding[] {
  const found: RawFinding[] = [];
  const { functions: fns } = input;

  // 1. Descoberta não vazia. `grep createServerFn` também conta o import e os
  //    comentários; o que vale é o número de declarações de fato.
  if (fns.length === 0) {
    found.push(
      finding(
        "contrato-de-borda",
        SIDE.discovery,
        "0 server functions declaradas em src/lib/*.functions.ts",
        `ao menos uma declaração 'export const … = createServerFn(' (descoberta vazia é parser quebrado, não árvore limpa; ver ${POLICY_DOC})`,
      ),
    );
  }

  // 2. Entrada validada — só para quem recebe entrada. `receivesInput === null`
  //    não é veredito: é precondição, tratada no relatório.
  for (const fn of fns) {
    if (fn.receivesInput === true && !fn.hasValidator) {
      found.push(
        finding(
          "contrato-de-borda",
          SIDE.input,
          `${fn.file}:${fn.line} ${fn.name} (${fn.method ?? "method?"}) recebe entrada sem .validator(`,
          ".validator((input: unknown) => schema.parse(input)) na cadeia da server function",
        ),
      );
    }
  }

  // 3. Validator presente precisa de schema Zod reconhecível. Um validator que
  //    não nomeia schema é a mesma função sem contrato, só mais difícil de ver.
  for (const fn of fns) {
    if (fn.hasValidator && fn.schemaName === null) {
      found.push(
        finding(
          "contrato-de-borda",
          SIDE.schema,
          `${fn.file}:${fn.line} ${fn.name} com .validator( sem schema Zod reconhecível no corpo`,
          "schema Zod nomeado (identificador.parse(input)) ou inline (z.object(...).parse(input))",
        ),
      );
    }
  }

  // 4. Taxonomia de erros do plano §6.9 — a lista do guard contra o que o
  //    arquivo declara. As duas pontas são lidas, nenhuma é hardcoded em cópia.
  //    Arquivo ausente/ilegível é PRECONDIÇÃO (tratada no relatório); arquivo
  //    legível sem um código do plano é veredito.
  if (input.apiErrorText !== null) {
    const declared = extractErrorCodes(input.apiErrorText);
    if (declared.length === 0) {
      found.push(
        finding(
          "taxonomia-de-erros",
          SIDE.taxonomy,
          `${API_ERROR_FILE} sem lista API_ERROR_CODES legível`,
          `os ${REQUIRED_ERROR_CODES.length} códigos do plano §6.9: ${REQUIRED_ERROR_CODES.join(", ")}`,
        ),
      );
    } else {
      const present = new Set(declared);
      const missing = REQUIRED_ERROR_CODES.filter((code) => !present.has(code));
      if (missing.length > 0) {
        found.push(
          finding(
            "taxonomia-de-erros",
            SIDE.taxonomy,
            `ausentes ${missing.join(", ")} (declarados: ${declared.join(", ")})`,
            `os ${REQUIRED_ERROR_CODES.length} códigos do plano §6.9: ${REQUIRED_ERROR_CODES.join(", ")}`,
          ),
        );
      }
    }
  }
  // 5. Tools de IA: `safeParse` no registry e schema em toda tool declarada.
  //    Arquivo ausente/ilegível é PRECONDIÇÃO (tratada no relatório).
  if (input.toolRegistryText !== null) {
    if (!input.toolRegistryText.includes("safeParse")) {
      found.push(
        finding(
          "tools-de-ia",
          SIDE.aiTools,
          "registry sem safeParse (entrada do modelo alcança o banco sem parse)",
          "definition.schema.safeParse(input) antes de autorizar e executar",
        ),
      );
    }
    if (input.aiTools.length === 0) {
      found.push(
        finding(
          "tools-de-ia",
          SIDE.aiTools,
          "0 tools declaradas em defineTool({",
          "ao menos uma tool declarada (descoberta vazia é parser quebrado)",
        ),
      );
    }
    for (const tool of input.aiTools) {
      if (!tool.hasSchema) {
        found.push(
          finding(
            "tools-de-ia",
            SIDE.aiTools,
            `${TOOL_REGISTRY_FILE}:${tool.line} tool '${tool.name}' sem schema de entrada`,
            "campo schema: com schema Zod na definição da tool",
          ),
        );
      }
    }
  }

  // 6. Contratos de saída: MEDIDOS, não escondidos, e regidos por um PISO
  //    declarado (`scripts/contract-baseline.json`), não por uma meta de 100%.
  //    A regra é "a dívida não cresce": toda função adicionada depois do piso
  //    precisa vir com schema de saída. Assim o check pode ser verde hoje sem
  //    que o número desapareça — ele vai em `observed` e no detalhe do check, e
  //    a dívida está nomeada em DBT-25. Crescer a dívida é que reprova.
  if (fns.length > 0) {
    const withOutput = fns.filter((fn) => fn.hasOutputContract).length;
    const base = input.baseline;
    if (base === null) {
      found.push(
        finding(
          "contrato-de-saída",
          SIDE.output,
          `piso declarado ausente (${BASELINE_FILE})`,
          "piso versionado: a dívida de contrato de saída não pode ser avaliada sem ele",
        ),
      );
    } else {
      const addedFns = fns.length - base.serverFunctions;
      const addedContracts = withOutput - base.outputContracts;
      // Duas condições independentes, porque "a dívida não cresce" tem dois jeitos
      // de ser violada: acrescentar função sem contrato, e remover função que já
      // tinha contrato. A segunda reduz a contagem de funções E a de contratos,
      // então um piso escrito só em "adicionados >= adicionados" deixaria passar.
      // Foi um teste que pegou isso, não uma revisão de leitura.
      if (withOutput < base.outputContracts) {
        found.push(
          finding(
            "contrato-de-saída",
            SIDE.output,
            `${withOutput} de ${fns.length} funções declaram schema de saída (piso ${base.outputContracts}/${base.serverFunctions})`,
            `contrato de saída perdido: eram ${base.outputContracts} no piso e agora são ${withOutput}; remover função que já tinha contrato regride a dívida — ver ${POLICY_DOC} e ${base.debt}`,
          ),
        );
      } else if (addedContracts < addedFns) {
        found.push(
          finding(
            "contrato-de-saída",
            SIDE.output,
            `${withOutput} de ${fns.length} funções declaram schema de saída (piso ${base.outputContracts}/${base.serverFunctions})`,
            `a dívida não pode crescer: ${addedFns} função(ões) adicionada(s) desde o piso, ${Math.max(addedContracts, 0)} com contrato de saída; toda função nova precisa vir com schema — ver ${POLICY_DOC} e ${base.debt}`,
          ),
        );
      }
    }
  }

  return found;
}

/** Findings como `string[]`, no formato `${sujeito} (${lado}): …`. */
export function auditContractCompliance(input: ContractGuardInput): string[] {
  return collectFindings(input).map((f) => f.text);
}

export interface ContractObserved {
  repo: string;
  scannedFiles: string[];
  serverFunctions: number;
  functionsReceivingInput: number;
  functionsWithoutInput: number;
  validators: number;
  outputContracts: number;
  /** 0..1. Nunca omitido e nunca arredondado para 1. */
  outputContractCoverage: number;
  requiredErrorCodes: string[];
  errorCodesDeclared: string[];
  missingErrorCodes: string[];
  aiTools: number;
  aiToolsWithoutSchema: string[];
  toolRegistryUsesSafeParse: boolean | null;
  indeterminateFunctions: string[];
}

export type CheckStatus = "pass" | "fail" | "skip";
export interface Check {
  id: string;
  status: CheckStatus;
  detail: string;
}

export type GuardStatus = "pass" | "fail" | "precondition";

export interface ContractGuardReport {
  findings: string[];
  observed: ContractObserved;
  checks: Check[];
  status: GuardStatus;
  exitCode: 0 | 1 | 2;
  precondition: string | null;
}

const EXIT_VERDICT = 1;
const EXIT_PRECONDITION = 2;

/** Métricas observadas; nada aqui é redigido — inclusive quando é zero. */
export function observeContractCompliance(input: ContractGuardInput): ContractObserved {
  const { functions: fns } = input;
  const declared = input.apiErrorText === null ? [] : extractErrorCodes(input.apiErrorText);
  const present = new Set(declared);
  return {
    repo: input.repo,
    scannedFiles: [...input.scannedFiles],
    serverFunctions: fns.length,
    functionsReceivingInput: fns.filter((fn) => fn.receivesInput === true).length,
    functionsWithoutInput: fns.filter((fn) => fn.receivesInput === false).length,
    validators: fns.filter((fn) => fn.hasValidator).length,
    outputContracts: fns.filter((fn) => fn.hasOutputContract).length,
    outputContractCoverage:
      fns.length === 0 ? 0 : fns.filter((fn) => fn.hasOutputContract).length / fns.length,
    requiredErrorCodes: [...REQUIRED_ERROR_CODES],
    errorCodesDeclared: declared,
    missingErrorCodes: declared.length
      ? REQUIRED_ERROR_CODES.filter((code) => !present.has(code))
      : [...REQUIRED_ERROR_CODES],
    aiTools: input.aiTools.length,
    aiToolsWithoutSchema: input.aiTools.filter((t) => !t.hasSchema).map((t) => t.name),
    toolRegistryUsesSafeParse:
      input.toolRegistryText === null ? null : input.toolRegistryText.includes("safeParse"),
    indeterminateFunctions: fns
      .filter((fn) => fn.receivesInput === null)
      .map((fn) => `${fn.file}:${fn.line} ${fn.name}`),
  };
}

/** Detalhe do check `pass` de cada lado — precisa dizer o número, não só "ok". */
function passDetail(side: Side, o: ContractObserved, baseline: ContractBaseline | null): string {
  switch (side) {
    case SIDE.discovery:
      return `${o.serverFunctions} server function(s) descoberta(s) em ${o.scannedFiles.length} arquivo(s)`;
    case SIDE.input:
      return `${o.functionsReceivingInput} função(ões) com entrada, todas com .validator(`;
    case SIDE.schema:
      return `${o.validators} validator(es), todos com schema Zod reconhecível`;
    case SIDE.taxonomy:
      return `${o.requiredErrorCodes.length} códigos do plano §6.9 declarados em src/lib/api-error.ts`;
    case SIDE.aiTools:
      return `${o.aiTools} tool(s) com schema de entrada e validação por safeParse`;
    case SIDE.output:
      return `cobertura de contrato de saída ${o.outputContractCoverage * 100}% (${o.outputContracts} de ${o.serverFunctions}); dívida declarada em ${baseline?.debt ?? "DBT-25"}, piso ${baseline?.outputContracts ?? "?"} de ${baseline?.serverFunctions ?? "?"}`;
  }
}

/**
 * Avaliação completa: findings, `observed`, `checks` e status. Puro — recebe
 * dados já lidos. A **precondição vence o veredito**: quando o parser não
 * consegue afirmar, o guard sai 2 e jamais `pass`.
 */
export function evaluateContractGuard(input: ContractGuardInput): ContractGuardReport {
  const raw = collectFindings(input);
  const observed = observeContractCompliance(input);

  const preconditions: string[] = [];
  if (input.apiErrorText === null) {
    preconditions.push(`${API_ERROR_FILE} ausente ou ilegível: a taxonomia não é verificável`);
  }
  if (input.toolRegistryText === null) {
    preconditions.push(`${TOOL_REGISTRY_FILE} ausente ou ilegível: as tools não são verificáveis`);
  }
  if (input.baseline === null) {
    preconditions.push(
      `${BASELINE_FILE} ausente ou ilegível: sem piso declarado não há como dizer se a dívida de contrato de saída cresceu`,
    );
  }
  if (observed.indeterminateFunctions.length > 0) {
    preconditions.push(
      `parâmetro de entrada indeterminável em ${observed.indeterminateFunctions.length} função(ões): ${observed.indeterminateFunctions.join("; ")} — o parser não pode afirmar, e não saber não é estar bem`,
    );
  }

  // Check que dependem da descoberta de server functions não podem "passar" no
  // vazio: 0 de 0 é inconclusivo, não aprovado. `contract-discovery` é que
  // reprova nesse caso; os demais saem `skip` para não registrar cobertura
  // aparente, que é o defeito que a política de dívidas já denuncia.
  const needsFunctions: Side[] = [SIDE.input, SIDE.schema, SIDE.output];
  const checks: Check[] = CHECK_ORDER.map((side) => {
    const own = raw.filter((f) => f.side === side).map((f) => f.text);
    if (own.length > 0) {
      return { id: CHECK_ID[side], status: "fail" as const, detail: own.join(" | ") };
    }
    if (observed.serverFunctions === 0 && needsFunctions.includes(side)) {
      return {
        id: CHECK_ID[side],
        status: "skip" as const,
        detail: "inconclusivo: 0 server functions descobertas (ver contract-discovery)",
      };
    }
    return {
      id: CHECK_ID[side],
      status: "pass" as const,
      detail: passDetail(side, observed, input.baseline),
    };
  });

  if (preconditions.length > 0) {
    const detail = `[precondição] ${preconditions.join(" | ")}`;
    return {
      findings: [...raw.map((f) => f.text), detail],
      observed,
      checks: [
        { id: "contract-precondition", status: "fail", detail },
        ...checks.map((c) => ({
          ...c,
          status: "skip" as CheckStatus,
          detail: `${c.detail} — inconclusivo: precondição`,
        })),
      ],
      status: "precondition",
      exitCode: EXIT_PRECONDITION,
      precondition: preconditions.join(" | "),
    };
  }

  const failed = checks.some((c) => c.status === "fail");
  return {
    findings: raw.map((f) => f.text),
    observed,
    checks,
    status: failed ? "fail" : "pass",
    exitCode: failed ? EXIT_VERDICT : 0,
    precondition: null,
  };
}

// ---------------------------------------------------------------------------
// CLI — todo o I/O mora aqui
// ---------------------------------------------------------------------------

function emit(report: ContractGuardReport): never {
  const reasons = report.checks
    .filter((c) => c.status === "fail")
    .map((c) => `${c.id}: ${c.detail}`);
  process.stdout.write(
    JSON.stringify(
      {
        schema: "contract-guard/1",
        ok: report.exitCode === 0,
        status: report.status,
        generatedAt: new Date().toISOString(),
        repo: report.observed.repo,
        observed: report.observed,
        checks: report.checks,
        reasons,
        hint: `Rode 'npm run guard:contracts' após qualquer mudança em src/lib/*.functions.ts, src/lib/api-error.ts ou src/lib/ai/tool-registry.ts; o contrato de saída está medido em ${POLICY_DOC}.`,
        ...(report.precondition ? { precondition: report.precondition } : {}),
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(report.exitCode);
}

function preconditionFail(reason: string, repo: string): never {
  emit({
    findings: [`[precondição] ${reason}`],
    observed: observeContractCompliance({
      repo,
      scannedFiles: [],
      functions: [],
      apiErrorText: null,
      aiTools: [],
      toolRegistryText: null,
      baseline: null,
    }),
    checks: [{ id: "contract-precondition", status: "fail", detail: `[precondição] ${reason}` }],
    status: "precondition",
    exitCode: EXIT_PRECONDITION,
    precondition: reason,
  });
}

/** Lê `src/lib/*.functions.ts` em ordem estável; `null` = diretório ausente. */
function readFunctionSources(root: string): SourceFile[] | null {
  const dir = path.join(root, FUNCTIONS_DIR);
  if (!existsSync(dir)) return null;
  return readdirSync(dir)
    .filter((name) => name.endsWith(FUNCTIONS_SUFFIX))
    .sort()
    .map((name) => {
      const full = path.join(dir, name);
      return { file: path.relative(root, full), text: readFileSync(full, "utf8") };
    });
}

function readOrNull(root: string, relative: string): string | null {
  const full = path.join(root, relative);
  if (!existsSync(full)) return null;
  try {
    return readFileSync(full, "utf8");
  } catch {
    return null;
  }
}

/**
 * Lê o piso declarado. Ausente, malformado ou com números degenerados vira
 * `null` — que o núcleo trata como **precondição**, nunca como piso zero
 * implícito. Um piso inventado seria pior que ausência: daria um verde que
 * ninguém Declarou.
 */
function readBaseline(root: string): ContractBaseline | null {
  const raw = readOrNull(root, BASELINE_FILE);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed.schema !== "contract-baseline/1") return null;
    const outputContracts = parsed.outputContracts;
    const serverFunctions = parsed.serverFunctions;
    const debt = parsed.debt;
    if (
      !Number.isInteger(outputContracts) ||
      !Number.isInteger(serverFunctions) ||
      (outputContracts as number) < 0 ||
      (serverFunctions as number) <= 0 ||
      typeof debt !== "string" ||
      debt.length === 0
    ) {
      return null;
    }
    return {
      outputContracts: outputContracts as number,
      serverFunctions: serverFunctions as number,
      debt,
    };
  } catch {
    return null;
  }
}

/** Monta o input do núcleo a partir da árvore — único lugar que toca `fs`. */
export function collectContractInput(root: string): ContractGuardInput {
  const sources = readFunctionSources(root) ?? [];
  const toolRegistryText = readOrNull(root, TOOL_REGISTRY_FILE);
  return {
    repo: root,
    scannedFiles: sources.map((s) => s.file),
    functions: discoverServerFunctions(sources),
    apiErrorText: readOrNull(root, API_ERROR_FILE),
    aiTools: toolRegistryText === null ? [] : discoverAiTools(toolRegistryText),
    toolRegistryText,
    baseline: readBaseline(root),
  };
}

export async function main(): Promise<never> {
  let root = process.cwd();
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top) root = top;
  } catch {
    preconditionFail("git indisponível: não foi possível localizar a raiz do repositório", root);
  }

  if (!existsSync(path.join(root, FUNCTIONS_DIR))) {
    preconditionFail(`superfície de BFF ausente (${FUNCTIONS_DIR})`, root);
  }
  if (readFunctionSources(root) === null) {
    preconditionFail(`leitura de ${FUNCTIONS_DIR}/*.functions.ts falhou`, root);
  }

  emit(evaluateContractGuard(collectContractInput(root)));
}

const entrypoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entrypoint) {
  await main();
}
