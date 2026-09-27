/**
 * Controles do contrato de SAÍDA do BFF (DBT-25).
 *
 * A dívida que este arquivo vigia: a entrada das server functions era validada
 * em 35 de 35 funções com entrada, e a saída em **nenhuma**. Um schema de saída
 * que ninguém falsifica é formulário em branco — por isso cada uma das cinco
 * funções contratadas tem aqui (a) um caso **negativo** que adultera o retorno
 * de verdade do serviço e exige `DEPENDENCY_ERROR`, e (b) um caso **positivo**
 * com uma resposta legítima, para que o contrato não seja um 503 permanente.
 *
 * **INV-013 é o caso que importa:** falha de parse não pode virar lista vazia
 * nem `null`. Os dois lados estão pinados: uma lista malformada **rejeita**, e
 * uma lista legitimamente vazia continua devolvendo `[]` — se o segundo caso
 * falhasse, o primeiro estaria passando pelo motivo errado.
 *
 * As fixtures são tipadas pelos tipos **reais** de retorno (`Expense`,
 * `Simulation`, `Product`, `DecimalScenarioResult`): o compilador garante que o
 * dado de teste tem a forma que a produção tem, então o caso positivo não pode
 * virar um objeto inventado que só o schema aceita.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { Expense, Simulation } from "@/db/schema";
import { getTotals, listExpenses } from "@/lib/expenses.functions";
import { listSimulations, runSimulation } from "@/lib/financial.functions";
import { outputSchema } from "@/lib/output-contract";
import { listProducts } from "@/lib/products.functions";
import type { RequestContext } from "@/lib/request-context";
import type { Product } from "@/server/contracts/product.contracts";
import type { DecimalString } from "@/lib/financial-values";
import type { DecimalScenarioResult } from "@/server/services/financial.service";

vi.mock("@tanstack/react-start", () => ({
  createMiddleware: () => ({ server: (handler: unknown) => handler }),
  createServerFn: () => {
    const builder = {
      middleware: () => builder,
      validator: () => builder,
      handler: (handler: unknown) => handler,
    };
    return builder;
  },
}));

const mocks = vi.hoisted(() => ({
  expenseList: vi.fn(),
  expenseTotals: vi.fn(),
  runSimulation: vi.fn(),
  simulationList: vi.fn(),
  loadReadModel: vi.fn(),
}));

vi.mock("@/server/services/expense.service", () => ({
  expenseService: {
    list: mocks.expenseList,
    save: vi.fn(),
    remove: vi.fn(),
    totals: mocks.expenseTotals,
  },
}));

vi.mock("@/server/services/financial.service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/server/services/financial.service")>()),
  runFinancialSimulation: mocks.runSimulation,
}));

vi.mock("@/server/services/simulation.service", () => ({
  simulationService: { list: mocks.simulationList, save: vi.fn() },
}));

vi.mock("@/server/services/product.service", () => ({
  productService: { loadReadModel: mocks.loadReadModel, loadDetail: vi.fn(), archive: vi.fn() },
}));

const TENANT_ID = "aaaaaaa1-0000-4000-8000-000000000001";
const USER_ID = "aaaaaaa3-0000-4000-8000-000000000003";
const CORRELATION_ID = "aaaaaaa2-0000-4000-8000-000000000002";

const CONTEXT = {
  context: {
    requestContext: {
      userId: USER_ID,
      tenantId: TENANT_ID,
      roles: ["owner"],
      correlationId: CORRELATION_ID,
      signal: new AbortController().signal,
    } satisfies Partial<RequestContext>,
  },
};

/** O handler é o valor exportado depois do `createServerFn` mockado. */
const invoke = (handler: unknown, input: unknown): Promise<unknown> =>
  (handler as (value: unknown) => Promise<unknown>)(input);

/**
 * Exige rejeição **e** o código certo. Se a função resolver, a mensagem carrega
 * o valor devolvido — uma lista vazia ou `null` aparecem nomeados na falha, que
 * é o defeito que INV-013 proíbe.
 */
async function expectDependencyError(promise: Promise<unknown>): Promise<void> {
  const outcome = await promise.then(
    (value) => ({ ok: true as const, value }),
    (error: unknown) => ({ ok: false as const, error }),
  );
  expect(
    outcome.ok,
    `esperado DEPENDENCY_ERROR, mas a função devolveu ${JSON.stringify(outcome.ok ? outcome.value : null)}`,
  ).toBe(false);
  if (outcome.ok) return;
  expect(outcome.error).toMatchObject({
    name: "ApplicationError",
    code: "DEPENDENCY_ERROR",
    status: 503,
    retryable: true,
  });
}

// ---------------------------------------------------------------------------
// Fixtures — tipadas pelos tipos reais de produção
// ---------------------------------------------------------------------------

const expenseRow = (over: Partial<Expense> = {}): Expense => ({
  id: "0f5a1c2e-0000-4000-8000-00000000000a",
  tenantId: TENANT_ID,
  userId: USER_ID,
  name: "Aluguel",
  category: "estrutura",
  amount: "1200.0000",
  type: "fixa",
  periodicity: "mensal",
  isDemo: false,
  notes: null,
  version: 3,
  createdAt: new Date("2026-01-01T00:00:00.000Z"),
  updatedAt: new Date("2026-01-02T00:00:00.000Z"),
  ...over,
});

const EXPECTED_EXPENSE_VIEW = {
  id: "0f5a1c2e-0000-4000-8000-00000000000a",
  user_id: USER_ID,
  tenant_id: TENANT_ID,
  name: "Aluguel",
  category: "estrutura",
  amount: "1200.0000",
  type: "fixa",
  periodicity: "mensal",
  is_demo: false,
  notes: null,
  version: 3,
  created_at: "2026-01-01T00:00:00.000Z",
  updated_at: "2026-01-02T00:00:00.000Z",
};

const simulationRow = (over: Partial<Simulation> = {}): Simulation => ({
  id: "0f5a1c2e-0000-4000-8000-00000000000b",
  tenantId: TENANT_ID,
  userId: USER_ID,
  productId: null,
  name: "Cenário base",
  params: { price: "10.0000", volume: "20.000000" },
  result: { status: "ok" },
  scenarioType: "manual_simulation",
  engineVersion: "finance-engine/2.0.0",
  createdAt: new Date("2026-01-03T00:00:00.000Z"),
  updatedAt: new Date("2026-01-04T00:00:00.000Z"),
  ...over,
});

const EXPECTED_SIMULATION_VIEW = {
  id: "0f5a1c2e-0000-4000-8000-00000000000b",
  product_id: null,
  tenant_id: TENANT_ID,
  name: "Cenário base",
  params: { price: "10.0000", volume: "20.000000" },
  result: { status: "ok" },
  scenario_type: "manual_simulation",
  engine_version: "finance-engine/2.0.0",
  created_at: "2026-01-03T00:00:00.000Z",
  updated_at: "2026-01-04T00:00:00.000Z",
};

const productRow = (over: Partial<Product> = {}): Product => ({
  id: "0f5a1c2e-0000-4000-8000-00000000000c",
  tenantId: TENANT_ID,
  userId: USER_ID,
  name: "Bolo de cenoura",
  status: "active",
  currentPrice: "10.0000",
  yieldQty: "12.000000",
  yieldUnit: "unidade",
  taxRegime: "simples",
  taxRate: "0.060000",
  isDemo: false,
  notes: null,
  version: 1,
  archivedAt: null,
  createdAt: new Date("2026-01-05T00:00:00.000Z"),
  updatedAt: new Date("2026-01-06T00:00:00.000Z"),
  ...over,
});

const readModel = (products: Product[]) => ({
  products,
  ingredients: [],
  packaging: [],
  fees: [],
  market: [],
});

/**
 * `DecimalString` é string com marca de tipo (`src/lib/financial-values.ts`), e
 * o motor devolve exatamente isso: a fixture precisa da mesma marca, senão o
 * dado de teste não é o dado de produção.
 */
const decimal = (value: string): DecimalString => value as DecimalString;

const scenarioResult = (over: Partial<DecimalScenarioResult> = {}): DecimalScenarioResult => ({
  price: decimal("10.0000"),
  unitCost: decimal("4.0000"),
  variableCost: decimal("4.0000"),
  contributionMargin: decimal("6.0000"),
  contributionMarginPct: decimal("0.600000"),
  breakEvenUnits: {
    status: "reachable",
    rawUnits: decimal("10.000000"),
    roundedUnits: decimal("10.000000"),
    unitMode: "discrete",
  },
  breakEvenRevenue: decimal("100.0000"),
  volume: decimal("20.000000"),
  volumeSource: "manual_simulation",
  revenue: decimal("200.0000"),
  totalVariable: decimal("80.0000"),
  totalContribution: decimal("120.0000"),
  result: decimal("40.0000"),
  resultSign: "positive",
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// 1. Caso negativo por função contratada: retorno adulterado ⇒ DEPENDENCY_ERROR
// ---------------------------------------------------------------------------

describe("1. retorno malformado nunca vira sucesso vazio", () => {
  it("expenses.listExpenses: item com `amount` não-decimal rejeita (não devolve lista)", async () => {
    mocks.expenseList.mockResolvedValue([expenseRow({ amount: "R$ 1.200,00" })]);

    await expectDependencyError(invoke(listExpenses, CONTEXT));
  });

  it("expenses.listExpenses: lista vazia legítima continua sendo [] — o vazio não é o erro", async () => {
    mocks.expenseList.mockResolvedValue([]);

    await expect(invoke(listExpenses, CONTEXT)).resolves.toEqual([]);
  });

  it("expenses.getTotals: soma que chega como número (não string decimal) rejeita", async () => {
    mocks.expenseTotals.mockResolvedValue({
      fixed: 1200 as unknown as string,
      variable: "0.0000",
      productCount: 2,
    });

    await expectDependencyError(invoke(getTotals, CONTEXT));
  });

  it("financial.runSimulation: `result` do motor como número rejeita, e nenhum status é aceito por engano", async () => {
    mocks.runSimulation.mockReturnValue({
      status: "ok",
      value: scenarioResult({ result: 40 as unknown as DecimalString }),
      warnings: [],
    });

    await expectDependencyError(invoke(runSimulation, { data: {} }));
  });

  it("financial.listSimulations: `params` que não é JSON object rejeita (não devolve lista)", async () => {
    mocks.simulationList.mockResolvedValue([
      simulationRow({ params: "não-é-json" as unknown as Record<string, unknown> }),
    ]);

    await expectDependencyError(invoke(listSimulations, CONTEXT));
  });

  it("products.listProducts: preço formatado para humano (`R$ 10,00`) rejeita (não devolve lista)", async () => {
    mocks.loadReadModel.mockResolvedValue(readModel([productRow({ currentPrice: "R$ 10,00" })]));

    await expectDependencyError(invoke(listProducts, CONTEXT));
  });

  it("products.listProducts: `version` que chega como string rejeita", async () => {
    mocks.loadReadModel.mockResolvedValue(
      readModel([productRow({ version: "1" as unknown as number })]),
    );

    await expectDependencyError(invoke(listProducts, CONTEXT));
  });
});

// ---------------------------------------------------------------------------
// 2. Caso positivo por função: resposta legítima passa e chega inteira
// ---------------------------------------------------------------------------

describe("2. resposta legítima atravessa o contrato sem perder campo", () => {
  it("expenses.listExpenses devolve a projeção snake_case completa", async () => {
    mocks.expenseList.mockResolvedValue([expenseRow()]);

    await expect(invoke(listExpenses, CONTEXT)).resolves.toEqual([EXPECTED_EXPENSE_VIEW]);
  });

  it("expenses.getTotals devolve fixed/variable/productCount", async () => {
    mocks.expenseTotals.mockResolvedValue({
      fixed: "1200.0000",
      variable: "0.0000",
      productCount: 0,
    });

    await expect(invoke(getTotals, CONTEXT)).resolves.toEqual({
      fixed: "1200.0000",
      variable: "0.0000",
      productCount: 0,
    });
  });

  it("financial.runSimulation aceita as três pernas da união do motor", async () => {
    const incomplete = {
      status: "incomplete",
      missing: [{ field: "volume", reason: "AUSENTE" }],
      warnings: [{ code: "W1", message: "aviso" }],
    };
    const invalid = { status: "invalid", errors: [{ code: "INVALID_PRICE", message: "preço" }] };

    for (const value of [
      { status: "ok", value: scenarioResult(), warnings: [] },
      incomplete,
      invalid,
    ]) {
      mocks.runSimulation.mockReturnValue(value);
      await expect(invoke(runSimulation, { data: {} })).resolves.toEqual(value);
    }
  });

  it("financial.listSimulations devolve params/result JSON e datas serializadas", async () => {
    mocks.simulationList.mockResolvedValue([simulationRow()]);

    await expect(invoke(listSimulations, CONTEXT)).resolves.toEqual([EXPECTED_SIMULATION_VIEW]);
  });

  it("products.listProducts devolve os preços que o banco entrega (strings decimais)", async () => {
    mocks.loadReadModel.mockResolvedValue(readModel([productRow()]));

    await expect(invoke(listProducts, CONTEXT)).resolves.toEqual([
      {
        id: "0f5a1c2e-0000-4000-8000-00000000000c",
        tenant_id: TENANT_ID,
        user_id: USER_ID,
        name: "Bolo de cenoura",
        // Preço, rendimento e alíquota presentes ⇒ `computeProduct` fecha em
        // `ok` e `productStatusFromCalculation` mantém "active" (só rebaixa
        // quando o cálculo não fecha ou o produto está arquivado). É resposta
        // legítima, e o contrato a aceita.
        status: "active",
        current_price: "10.0000",
        yield_qty: "12.000000",
        yield_unit: "unidade",
        tax_regime: "simples",
        tax_rate: "0.060000",
        is_demo: false,
        notes: null,
        version: 1,
        archived_at: null,
        created_at: "2026-01-05T00:00:00.000Z",
        updated_at: "2026-01-06T00:00:00.000Z",
      },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 3. O mecanismo: erro estruturado, e o valor parseado (nunca o cru)
// ---------------------------------------------------------------------------

describe("3. outputSchema — canal de falha do contrato", () => {
  const schema = z.object({ amount: z.string() });
  const subject = "teste.contrato";

  it("registra `bff.output_contract_violation` com o sujeito e o caminho do campo", () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    expect(() => outputSchema(schema, subject, { amount: 1 })).toThrowError(
      /Contrato de saída violado em teste\.contrato/,
    );

    const record = JSON.parse(String(errorSpy.mock.calls[0]?.[0])) as {
      level: string;
      event: string;
      subject: string;
      issues: Array<{ path: string }>;
    };
    expect(record).toMatchObject({ level: "error", event: "bff.output_contract_violation" });
    expect(record.subject).toBe(subject);
    expect(record.issues[0]?.path).toBe("amount");
    errorSpy.mockRestore();
  });

  it("devolve o valor parseado, não o cru (a transformação do schema vale)", () => {
    const transformed = z.object({ amount: z.string().transform((value) => `${value}!`) });

    expect(outputSchema(transformed, subject, { amount: "10.0000" })).toEqual({
      amount: "10.0000!",
    });
  });

  it("falha de parse em schema de lista não devolve [] nem null", () => {
    const listSchema = z.array(z.object({ id: z.string() }));

    for (const malformed of [{}, null, [{}], [{ id: 1 }]]) {
      expect(() => outputSchema(listSchema, subject, malformed)).toThrowError();
    }
    expect(outputSchema(listSchema, subject, [])).toEqual([]);
  });
});
