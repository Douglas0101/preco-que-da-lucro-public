/**
 * Controles negativos e de sanidade do `contract-guard`.
 *
 * Todos os casos partem de um input **válido** (`baseInput()`) e alteram **um**
 * campo, afirmando a finding específica. O núcleo (`auditContractCompliance` /
 * `evaluateContractGuard`) é puro: recebe dados já lidos, não toca `fs`, não
 * precisa de banco nem de um segundo `node_modules` para ser falsificado — por
 * isso estes testes são herméticos e reais: se a lógica sair, eles reprovariam.
 *
 * O bloco "árvore real" é a outra ponta: ele lê `src/lib/*.functions.ts` de fato
 * e afirma que o guard **não** acusa entrada não validada. Se essa asserção
 * falhar, ou o repositório tem hole real ou o parser é ruim — e o caso 5.2
 * (função sem entrada e sem validator ⇒ zero findings) existe para distinguir as
 * duas coisas.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Onde o piso declarado mora — o mesmo arquivo que o CLI lê. */
const BASELINE_PATH = "scripts/contract-baseline.json";

import type { ContractGuardInput, ServerFunctionDecl } from "../../scripts/lib/contract-guard";
import {
  REQUIRED_ERROR_CODES,
  auditContractCompliance,
  collectContractInput,
  discoverServerFunctions,
  evaluateContractGuard,
  extractErrorCodes,
} from "../../scripts/lib/contract-guard";

/** `api-error.ts` sintético que declara exatamente a taxonomia do plano §6.9. */
const apiErrorTextWith = (codes: readonly string[]): string =>
  `export const API_ERROR_CODES = [${codes.map((c) => `"${c}"`).join(", ")}] as const;`;

const fn = (over: Partial<ServerFunctionDecl> = {}): ServerFunctionDecl => ({
  file: "src/lib/products.functions.ts",
  line: 444,
  name: "createProduct",
  method: "POST",
  hasValidator: true,
  schemaName: "createProductInput",
  receivesInput: true,
  hasOutputContract: true,
  ...over,
});

/** Input verde: 100% de cobertura, entrada validada, taxonomia completa. */
const baseInput = (): ContractGuardInput => ({
  repo: "/repo",
  scannedFiles: ["src/lib/products.functions.ts"],
  functions: [
    fn(),
    fn({
      line: 339,
      name: "listProducts",
      method: "GET",
      hasValidator: false,
      schemaName: null,
      receivesInput: false,
    }),
  ],
  apiErrorText: apiErrorTextWith(REQUIRED_ERROR_CODES),
  aiTools: [{ name: "create_product", line: 100, hasSchema: true }],
  toolRegistryText: "const parsed = definition.schema.safeParse(input);",
  baseline: { outputContracts: 1, serverFunctions: 2, debt: "DBT-25" },
});

/** Findings de um lado específico, sem depender de ordem nem de comprimento. */
const findingsOn = (input: ContractGuardInput, side: string): string[] =>
  auditContractCompliance(input).filter((f) => f.includes(`(${side}):`));

const check = (input: ContractGuardInput, id: string) =>
  evaluateContractGuard(input).checks.find((c) => c.id === id);

describe("1. sanidade na árvore real", () => {
  it("não acusa entrada não validada em nenhuma das server functions do repositório", () => {
    const report = evaluateContractGuard(collectContractInput(process.cwd()));

    // Se esta linha falhar, ou existe hole real no repositório, ou o parser
    // está errado. Os dois precisam ser descobertos antes de seguir.
    expect(findingsOn(collectContractInput(process.cwd()), "entrada")).toEqual([]);
    expect(report.observed.functionsReceivingInput).toBeGreaterThan(0);
    expect(report.observed.indeterminateFunctions).toEqual([]);
    expect(check(collectContractInput(process.cwd()), "contract-input-validated")?.status).toBe(
      "pass",
    );
  });

  it("mede a descoberta real: funções com entrada, sem entrada e contrato de saída", () => {
    const o = evaluateContractGuard(collectContractInput(process.cwd())).observed;

    expect(o.scannedFiles).toHaveLength(8);
    expect(o.serverFunctions).toBe(
      o.functionsReceivingInput + o.functionsWithoutInput + o.indeterminateFunctions.length,
    );
    expect(o.functionsWithoutInput).toBeGreaterThan(0); // os GET sem parâmetro
    expect(o.validators).toBe(o.functionsReceivingInput);
    expect(o.outputContracts).toBe(5);
    expect(o.outputContractCoverage).toBe(5 / 35);
    expect(o.missingErrorCodes).toEqual([]);
    expect(o.aiTools).toBeGreaterThan(0);
    expect(o.aiToolsWithoutSchema).toEqual([]);
    expect(o.toolRegistryUsesSafeParse).toBe(true);
  });

  it("a árvore real está no piso declarado: verde, com o 5 visível e a dívida nomeada", () => {
    const input = collectContractInput(process.cwd());
    const report = evaluateContractGuard(input);

    expect(report.status).toBe("pass");
    expect(findingsOn(input, "saída")).toEqual([]);

    // O verde não pode comer o número: a dívida de saída encolheu de 0 para 5
    // contratos e continua escrita.
    expect(report.observed.outputContracts).toBe(5);
    expect(report.observed.outputContractCoverage).toBe(5 / 35);
    const detail = check(input, "contract-output-ratchet")?.detail ?? "";
    expect(detail).toContain(`5 de ${report.observed.serverFunctions}`);
    expect(detail).toContain("dívida declarada em DBT-25");
  });

  /**
   * O número sozinho não diz **quais** funções têm contrato: um crédito
   * acidental (uma menção em comentário, por exemplo) inflaria a contagem sem
   * contrato nenhum. Este caso pina a identidade das cinco, não a cardinalidade.
   */
  it("as cinco funções com contrato de saída são as nomeadas — contagem não basta", () => {
    const input = collectContractInput(process.cwd());
    const contracted = input.functions.filter((fn) => fn.hasOutputContract);

    expect(contracted).toHaveLength(5);
    expect(contracted.map((fn) => fn.name).sort()).toEqual([
      "getTotals",
      "listExpenses",
      "listProducts",
      "listSimulations",
      "runSimulation",
    ]);
    for (const fn of contracted) {
      expect(fn.receivesInput, `${fn.name} indeterminável`).not.toBeNull();
    }
  });

  it("o piso versionado bate com a árvore real — senão o verde é de um número inventado", () => {
    const baseline = JSON.parse(
      readFileSync(
        resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", BASELINE_PATH),
        "utf8",
      ),
    ) as { outputContracts: number; serverFunctions: number; debt: string };
    const observed = evaluateContractGuard(collectContractInput(process.cwd())).observed;

    expect(baseline.outputContracts).toBe(observed.outputContracts);
    expect(baseline.serverFunctions).toBe(observed.serverFunctions);
    expect(baseline.debt).toBe("DBT-25");
  });
});

describe("2. discovery", () => {
  it("descoberta vazia é finding, não pass", () => {
    const input: ContractGuardInput = { ...baseInput(), functions: [] };

    const findings = findingsOn(input, "descoberta");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("0 server functions declaradas");
    expect(evaluateContractGuard(input).status).toBe("fail");
    expect(check(input, "contract-discovery")?.status).toBe("fail");
  });

  it("descoberta vazia não produz pass vazio nos checks que dependem dela", () => {
    const report = evaluateContractGuard({ ...baseInput(), functions: [] });

    // 0 de 0 é inconclusivo, não aprovado: cobertura aparente é o pior resultado.
    for (const id of [
      "contract-input-validated",
      "contract-schema-declared",
      "contract-output-ratchet",
    ]) {
      expect(report.checks.find((c) => c.id === id)?.status, id).toBe("skip");
    }
    expect(report.observed.outputContractCoverage).toBe(0);
    expect(report.exitCode).toBe(1);
  });

  it("o parser distingue função sem entrada de função com entrada", () => {
    const discovered = discoverServerFunctions([
      {
        file: "src/lib/x.functions.ts",
        text: [
          'export const listThings = createServerFn({ method: "GET" })',
          "  .middleware([requireDatabaseAuth])",
          "  .handler(async ({ context }) => list(context.requestContext));",
          "",
          'export const saveThing = createServerFn({ method: "POST" })',
          "  .middleware([requireDatabaseAuth])",
          "  .validator((input: unknown) => thingInput.parse(input))",
          "  .handler(async ({ data, context }) => save(context.requestContext, data));",
        ].join("\n"),
      },
    ]);

    expect(discovered).toHaveLength(2);
    expect(discovered[0].name).toBe("listThings");
    expect(discovered[0].receivesInput).toBe(false);
    expect(discovered[0].hasValidator).toBe(false);
    expect(discovered[0].method).toBe("GET");
    expect(discovered[1].name).toBe("saveThing");
    expect(discovered[1].receivesInput).toBe(true);
    expect(discovered[1].schemaName).toBe("thingInput");
    expect(discovered[1].line).toBe(5);
  });
});

describe("3. entrada validada", () => {
  it("base válida não produz finding alguma", () => {
    expect(auditContractCompliance(baseInput())).toEqual([]);
    expect(evaluateContractGuard(baseInput()).exitCode).toBe(0);
  });

  it("função com entrada e sem validator é finding nomeando arquivo:linha", () => {
    const input: ContractGuardInput = {
      ...baseInput(),
      functions: [fn({ hasValidator: false, schemaName: null }), baseInput().functions[1]],
    };

    const findings = findingsOn(input, "entrada");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("src/lib/products.functions.ts:444");
    expect(findings[0]).toContain("createProduct");
    expect(findings[0]).toContain("recebe entrada sem .validator(");
    expect(check(input, "contract-input-validated")?.status).toBe("fail");
  });

  it("função sem entrada e sem validator NÃO é finding — o falso positivo que não pode existir", () => {
    const input: ContractGuardInput = {
      ...baseInput(),
      functions: [
        fn({ method: "GET", hasValidator: false, schemaName: null, receivesInput: false }),
      ],
    };

    expect(auditContractCompliance(input)).toEqual([]);
    expect(evaluateContractGuard(input).exitCode).toBe(0);
    expect(evaluateContractGuard(input).observed.functionsWithoutInput).toBe(1);
  });
});

describe("4. schema declarado", () => {
  it("validator sem schema Zod reconhecível é finding", () => {
    const input: ContractGuardInput = {
      ...baseInput(),
      functions: [fn({ schemaName: null }), baseInput().functions[1]],
    };

    const findings = findingsOn(input, "schema");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("src/lib/products.functions.ts:444");
    expect(findings[0]).toContain("sem schema Zod reconhecível");
    expect(check(input, "contract-schema-declared")?.status).toBe("fail");
  });

  it("reconhece schema inline (z.object) e nomeado (identificador.parse)", () => {
    const discovered = discoverServerFunctions([
      {
        file: "src/lib/x.functions.ts",
        text: [
          'export const getOne = createServerFn({ method: "GET" })',
          "  .validator((input: unknown) => z.object({ id: uuid }).parse(input))",
          "  .handler(async ({ data }) => data);",
          "",
          'export const bare = createServerFn({ method: "POST" })',
          "  .validator((input: unknown) => (input as never))",
          "  .handler(async ({ data }) => data);",
        ].join("\n"),
      },
    ]);

    expect(discovered[0].schemaName).toBe("z.*");
    expect(discovered[1].schemaName).toBeNull();
    expect(findingsOn({ ...baseInput(), functions: [discovered[1]] }, "schema")).toHaveLength(1);
  });
});

describe("5. taxonomia de erros (plano §6.9)", () => {
  it("código ausente de api-error.ts é finding nomeando o código", () => {
    const incomplete = REQUIRED_ERROR_CODES.filter((c) => c !== "AI_QUOTA");
    const input: ContractGuardInput = {
      ...baseInput(),
      apiErrorText: apiErrorTextWith(incomplete),
    };

    const findings = findingsOn(input, "taxonomia");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("ausentes AI_QUOTA");
    expect(check(input, "contract-error-taxonomy")?.status).toBe("fail");
  });

  it("lê os códigos declarados do arquivo, sem espelhar a lista em cópia local", () => {
    const text = apiErrorTextWith([...REQUIRED_ERROR_CODES, "RATE_LIMIT", "INTERNAL_ERROR"]);

    expect(extractErrorCodes(text)).toHaveLength(REQUIRED_ERROR_CODES.length + 2);
    expect(findingsOn({ ...baseInput(), apiErrorText: text }, "taxonomia")).toEqual([]);
    expect(
      evaluateContractGuard({ ...baseInput(), apiErrorText: text }).observed.errorCodesDeclared,
    ).toHaveLength(REQUIRED_ERROR_CODES.length + 2);
  });

  it("api-error.ts ilegível é precondição, não aprovação", () => {
    const input: ContractGuardInput = { ...baseInput(), apiErrorText: null };

    const report = evaluateContractGuard(input);
    expect(findingsOn(input, "taxonomia")).toEqual([]);
    expect(report.exitCode).toBe(2);
    expect(report.status).toBe("precondition");
    expect(report.precondition).toContain("api-error.ts");
    expect(report.checks.some((c) => c.status === "pass")).toBe(false);
  });

  it("lista legível sem os códigos do plano é veredito (1), não precondição (2)", () => {
    const input: ContractGuardInput = { ...baseInput(), apiErrorText: "export const X = 1;" };

    const findings = findingsOn(input, "taxonomia");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("sem lista API_ERROR_CODES legível");
    expect(evaluateContractGuard(input).exitCode).toBe(1);
  });

  it("tool registry ilegível é precondição, não aprovação", () => {
    const input: ContractGuardInput = { ...baseInput(), toolRegistryText: null, aiTools: [] };

    const report = evaluateContractGuard(input);
    expect(report.exitCode).toBe(2);
    expect(report.status).toBe("precondition");
    expect(report.precondition).toContain("tool-registry.ts");
    expect(report.observed.toolRegistryUsesSafeParse).toBeNull();
  });
});

describe("6. tools de IA", () => {
  it("safeParse removido do tool registry é finding", () => {
    const input: ContractGuardInput = {
      ...baseInput(),
      toolRegistryText: "const parsed = { success: true, data: input };",
    };

    const findings = findingsOn(input, "tools-ia");
    expect(findings.some((f) => f.includes("registry sem safeParse"))).toBe(true);
    expect(check(input, "contract-ai-tool-validation")?.status).toBe("fail");
    expect(evaluateContractGuard(input).observed.toolRegistryUsesSafeParse).toBe(false);
  });

  it("tool sem schema de entrada é finding", () => {
    const input: ContractGuardInput = {
      ...baseInput(),
      aiTools: [
        { name: "create_product", line: 100, hasSchema: true },
        { name: "drop_table", line: 152, hasSchema: false },
      ],
    };

    const findings = findingsOn(input, "tools-ia");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("tool 'drop_table' sem schema de entrada");
    expect(findings[0]).toContain(":152");
    expect(evaluateContractGuard(input).observed.aiToolsWithoutSchema).toEqual(["drop_table"]);
  });

  it("descoberta de tools vazia é finding — parser quebrado não é registry limpo", () => {
    const input: ContractGuardInput = { ...baseInput(), aiTools: [] };

    expect(findingsOn(input, "tools-ia").some((f) => f.includes("0 tools declaradas"))).toBe(true);
    expect(evaluateContractGuard(input).status).toBe("fail");
  });
});

describe("7. contratos de saída (medidos, nunca mascarados)", () => {
  it("cobertura abaixo do piso declarado é finding, e o número aparece em observed", () => {
    const input: ContractGuardInput = {
      ...baseInput(),
      functions: baseInput().functions.map((f) => ({ ...f, hasOutputContract: false })),
    };

    const findings = findingsOn(input, "saída");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("0 de 2 funções declaram schema de saída");
    expect(findings[0]).toContain("piso 1/2");

    const report = evaluateContractGuard(input);
    expect(report.observed.outputContracts).toBe(0);
    expect(report.observed.outputContractCoverage).toBe(0);
    expect(check(input, "contract-output-ratchet")?.status).toBe("fail");
    expect(report.exitCode).toBe(1);
  });

  it("cobertura parcial não arredonda para pass", () => {
    const input: ContractGuardInput = {
      ...baseInput(),
      functions: [
        { ...baseInput().functions[0], hasOutputContract: false },
        baseInput().functions[1],
      ],
    };

    // A razão medida não é arredondada: 0,5 aparece como 0,5. O veredito agora
    // é do piso declarado (contagem), não da razão — cobertura parcial é
    // aceitável desde que a contagem de contratos não caia abaixo do piso.
    expect(evaluateContractGuard(input).observed.outputContractCoverage).toBe(0.5);
    expect(check(input, "contract-output-ratchet")?.status).toBe("pass");
  });

  it("cobertura em 100% vira pass — o caminho verde existe e é alcançável", () => {
    const report = evaluateContractGuard(baseInput());

    expect(report.observed.outputContracts).toBe(2);
    expect(report.observed.outputContractCoverage).toBe(1);
    expect(findingsOn(baseInput(), "saída")).toEqual([]);
    expect(check(baseInput(), "contract-output-ratchet")?.status).toBe("pass");
    expect(report.checks.every((c) => c.status === "pass")).toBe(true);
    expect(report.exitCode).toBe(0);
  });
});

describe("8. parâmetro indeterminável é precondição (exit 2), nunca pass", () => {
  it("receivesInput null sai com status precondition e checks inconclusivos", () => {
    const input: ContractGuardInput = {
      ...baseInput(),
      functions: [fn({ receivesInput: null }), baseInput().functions[1]],
    };

    const report = evaluateContractGuard(input);
    expect(report.exitCode).toBe(2);
    expect(report.status).toBe("precondition");
    expect(report.observed.indeterminateFunctions).toEqual([
      "src/lib/products.functions.ts:444 createProduct",
    ]);
    expect(report.checks.find((c) => c.id === "contract-precondition")?.status).toBe("fail");
    // Nenhum check pode se dizer `pass` sob precondição: é "não sei", não "ok".
    expect(report.checks.some((c) => c.status === "pass")).toBe(false);
    expect(
      report.checks.every((c) => c.status === "skip" || c.id === "contract-precondition"),
    ).toBe(true);
  });

  it("o parser produz receivesInput null quando não reconhece a assinatura do handler", () => {
    const discovered = discoverServerFunctions([
      {
        file: "src/lib/x.functions.ts",
        text: [
          'export const mystery = createServerFn({ method: "POST" })',
          "  .middleware([requireDatabaseAuth])",
          "  .handler(legadoHandler);",
        ].join("\n"),
      },
    ]);

    expect(discovered).toHaveLength(1);
    expect(discovered[0].receivesInput).toBeNull();

    const report = evaluateContractGuard({ ...baseInput(), functions: discovered });
    expect(report.exitCode).toBe(2);
    expect(report.status).toBe("precondition");
  });
});

/**
 * 9. Piso declarado (`scripts/contract-baseline.json`).
 *
 * A dívida de contrato de saída é real e hoje vale 5 de 35. O guard não pode
 * ficar vermelho para sempre (ninguém roda um gate que nunca passa) nem verde
 * por definicao de meta de 100% (seria cobertura aparente). A regra é
 * **"a dívida não cresce"**: toda função adicionada depois do piso precisa vir
 * com schema de saída. O número absoluto continua visível em `observed` e no
 * detalhe do check.
 */
describe("9. piso declarado: a dívida pode diminuir, nunca crescer", () => {
  /** `count` funções com entrada validada e `withOutput` delas com contrato de saída. */
  const many = (count: number, withOutput: number): ServerFunctionDecl[] =>
    Array.from({ length: count }, (_, i) =>
      fn({
        line: 100 + i,
        name: `fn${i}`,
        method: "POST",
        hasValidator: true,
        schemaName: "zodSchema",
        receivesInput: true,
        hasOutputContract: i < withOutput,
      }),
    );

  it("dívida estável no piso é pass, com o número absoluto no detalhe do check", () => {
    const input: ContractGuardInput = {
      ...baseInput(),
      functions: many(35, 0),
      baseline: { outputContracts: 0, serverFunctions: 35, debt: "DBT-25" },
    };
    const report = evaluateContractGuard(input);
    expect(findingsOn(input, "saída")).toEqual([]);
    expect(report.status).toBe("pass");
    expect(report.observed.outputContracts).toBe(0);
    // O verde não come o número: quem lê o relatório vê 0 de 35 e a dívida nomeada.
    expect(check(input, "contract-output-ratchet")?.detail).toContain("0 de 35");
    expect(check(input, "contract-output-ratchet")?.detail).toContain("DBT-25");
  });

  it("função nova SEM contrato de saída reprova — a dívida cresceu", () => {
    const input: ContractGuardInput = {
      ...baseInput(),
      functions: many(36, 0),
      baseline: { outputContracts: 0, serverFunctions: 35, debt: "DBT-25" },
    };
    const findings = findingsOn(input, "saída");
    expect(findings).toHaveLength(1);
    expect(findings[0]).toContain("1 função(ões) adicionada(s) desde o piso");
    expect(findings[0]).toContain("0 com contrato de saída");
    expect(evaluateContractGuard(input).exitCode).toBe(1);
  });

  it("função nova COM contrato de saída não reprova — a dívida diminuiu", () => {
    const input: ContractGuardInput = {
      ...baseInput(),
      functions: many(36, 1),
      baseline: { outputContracts: 0, serverFunctions: 35, debt: "DBT-25" },
    };
    expect(findingsOn(input, "saída")).toEqual([]);
    expect(evaluateContractGuard(input).status).toBe("pass");
  });

  it("remover função com contrato de saída reprova — a dívida cresceu", () => {
    const input: ContractGuardInput = {
      ...baseInput(),
      functions: many(34, 0),
      baseline: { outputContracts: 1, serverFunctions: 35, debt: "DBT-25" },
    };
    expect(findingsOn(input, "saída")[0]).toContain("contrato de saída perdido");
  });

  it("piso ausente é PRECONDIÇÃO (exit 2), nunca um piso zero implícito", () => {
    const input: ContractGuardInput = { ...baseInput(), functions: many(35, 0), baseline: null };
    const report = evaluateContractGuard(input);
    expect(report.status).toBe("precondition");
    expect(report.exitCode).toBe(2);
    expect(report.precondition).toContain("contract-baseline.json");
  });
});
