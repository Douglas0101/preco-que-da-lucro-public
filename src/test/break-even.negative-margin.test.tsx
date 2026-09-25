/**
 * WP-B7 — borda da margem de contribuição não positiva.
 *
 * Defeito medido no ciclo 7: `parseDecimal` rejeitava qualquer decimal negativo
 * e `parseBaseInputs` o usava para `contributionMargin`, então uma margem
 * negativa (preço abaixo do custo variável) virava `INVALID_DECIMAL` →
 * `status:"invalid"` → "Erro de cálculo" em /ponto-equilibrio, enquanto
 * /diagnostico (motor `finance.ts`) já classificava o MESMO estado como
 * "Não atingível". A margem não positiva é um estado econômico, não uma entrada
 * inválida: deve fluir até o ramo NON_POSITIVE_CONTRIBUTION de `calculateUnits`.
 *
 * Este arquivo cobre, nas três bordas (cm<0, cm=0, cm>0):
 *   1. o status calculado pelo motor compartilhado (`@/lib/break-even`);
 *   2. a concordância entre os dois motores (`break-even.ts` × `finance.ts`);
 *   3. a concordância entre as duas rotas/serviços (/ponto-equilibrio e
 *      /diagnostico), exercitando `getDiagnostic` real e o rótulo renderizado;
 *   4. INV-006/007: nunca serializar NaN/Infinity nem fabricar zero para
 *      "unknown".
 */
import { render, within } from "@testing-library/react";
import { PgDialect, QueryBuilder } from "drizzle-orm/pg-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  marketPrices,
  productIngredients,
  productPackaging,
  products,
  salesFees,
} from "@/db/schema";
import type { RequestContext } from "@/lib/request-context";

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

const expenseMocks = vi.hoisted(() => ({
  rows: [] as Array<{ type: string; amount: string }>,
}));

vi.mock("@/server/services/expense.service", () => ({
  expenseService: { list: async () => expenseMocks.rows },
}));

vi.mock("@/server/services/calculation-snapshot.service", () => ({
  calculationSnapshotService: { append: async () => ({}) },
  deriveSnapshotIdempotencyKey: () => "test-idempotency-key",
}));

vi.mock("@/server/services/pricing.service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/server/services/pricing.service")>();
  return {
    ...actual,
    pricingService: {
      calculatePriceFormationFor: actual.pricingService.calculatePriceFormationFor.bind(
        actual.pricingService,
      ),
      appendPricingSnapshot: async () => undefined,
    },
  };
});

/**
 * Superfícies de leitura das rotas: o BFF é a fronteira legítima de mock. Os
 * motores (`break-even.ts`/`finance.ts`) permanecem reais.
 */
const surface = vi.hoisted(() => ({
  details: undefined as unknown,
  products: undefined as unknown,
  expenses: undefined as unknown,
  view: undefined as unknown,
}));

vi.mock("@/lib/query-options", () => ({
  productsWithMetricsQueryOptions: () => ({ queryKey: ["products", "with-metrics"] }),
  productsListQueryOptions: () => ({ queryKey: ["products", "list"] }),
  expensesQueryOptions: () => ({ queryKey: ["expenses"] }),
}));

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  const settled = (data: unknown) => ({
    data,
    isPending: false,
    isError: false,
    isSuccess: true,
    refetch: () => Promise.resolve(),
  });
  return {
    ...actual,
    useQueries: ({ queries }: { queries: Array<{ queryKey: unknown[] }> }) =>
      queries.map((query) => {
        const [kind, variant] = query.queryKey;
        if (kind === "products" && variant === "with-metrics") return settled(surface.details);
        if (kind === "products") return settled(surface.products);
        if (kind === "expenses") return settled(surface.expenses);
        return settled(undefined);
      }),
    useQuery: () => settled(surface.view),
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => () => Promise.resolve(),
    Link: ({ children, to, ...props }: { children?: unknown; to?: string }) => (
      <a href={typeof to === "string" ? to : undefined} {...props}>
        {children as never}
      </a>
    ),
  };
});

import { calculateBreakEvenSummary } from "@/lib/break-even";
import { calculateBreakEvenUnits, calculateContributionMargin } from "@/lib/finance";
import { getDiagnostic, type DiagnosticView } from "@/server/services/diagnostic.service";
import { Route as DiagnosticoRoute } from "@/routes/_authenticated/diagnostico";
import { Route as PontoEquilibrioRoute } from "@/routes/_authenticated/ponto-equilibrio";
import type { ReactElement } from "react";

const TENANT_ID = "bbbbbbb1-0000-4000-8000-000000000001";
const CORRELATION_ID = "bbbbbbb2-0000-4000-8000-000000000002";
const PRODUCT_ID = "bbbbbbb3-0000-4000-8000-000000000003";
const FIXED_EXPENSES = "1000";
const PRICE = 25;
const TAX_RATE = 0.1;
const VARIABLE_COST = PRICE * TAX_RATE; // 2.5 — o imposto entra como custo variável

/**
 * As três bordas da margem de contribuição por unidade. `packagePrice` de uma
 * única matéria-prima (rendimento 1, sem embalagem) produz exatamente `cm`:
 * cm = preço − custoUnitário − custoVariável.
 */
const EDGES = [
  { name: "margem negativa", cm: -9.15, pct: -36.6, expected: "unreachable" },
  { name: "margem zero", cm: 0, pct: 0, expected: "unreachable" },
  { name: "margem positiva", cm: 10.5, pct: 42, expected: "reachable" },
] as const;

function packagePriceFor(cm: number): number {
  return PRICE - VARIABLE_COST - cm;
}

function summaryFor(edge: (typeof EDGES)[number]) {
  return calculateBreakEvenSummary({
    fixedExpenses: [FIXED_EXPENSES],
    price: String(PRICE),
    contributionMargin: String(edge.cm),
    contributionMarginPct: String(edge.pct),
    desiredProfit: null,
    unitMode: "discrete",
  });
}

function productRow(packagePrice: number) {
  return {
    id: PRODUCT_ID,
    tenantId: TENANT_ID,
    userId: "user-1",
    name: "Bolo de Cacau",
    status: "active" as const,
    currentPrice: String(PRICE),
    yieldQty: "1.000000",
    yieldUnit: "unidades",
    taxRegime: "simples nacional",
    taxRate: String(TAX_RATE),
    isDemo: false,
    notes: null,
    version: 0,
    archivedAt: null,
    createdAt: new Date("2026-01-03T10:00:00.000Z"),
    updatedAt: new Date("2026-01-03T10:00:00.000Z"),
  };
}

function ingredientRow(packagePrice: number) {
  return {
    id: "bbbbbbb4-0000-4000-8000-000000000004",
    productId: PRODUCT_ID,
    tenantId: TENANT_ID,
    userId: "user-1",
    name: "Farinha",
    usedQty: "1.000000",
    usedUnit: "kg",
    packagePrice: String(packagePrice),
    packageQty: "1.000000",
    packageUnit: "kg",
    conversionFactor: "1.00000000",
    priceUpdatedAt: new Date("2026-01-02T12:00:00.000Z"),
    createdAt: new Date("2026-01-03T10:05:00.000Z"),
    updatedAt: new Date("2026-01-03T10:05:00.000Z"),
  };
}

type Dataset = {
  products: Array<ReturnType<typeof productRow>>;
  ingredients: Array<ReturnType<typeof ingredientRow>>;
  packaging: Array<typeof productPackaging.$inferSelect>;
  fees: Array<typeof salesFees.$inferSelect>;
  market: Array<typeof marketPrices.$inferSelect>;
};

/** Transação em memória: o read model real roda sobre um driver falso. */
function createFakeTransaction(data: Dataset): RequestContext["transaction"] {
  const dialect = new PgDialect();
  const queryBuilder = new QueryBuilder();
  const unionRow = (branch: number, kind: string, row: object, index: number) => ({
    branch,
    ord: index + 1,
    kind,
    ...row,
  });
  const rowsForTable = (renderedSql: string): object[] => {
    if (renderedSql.includes('from "products"')) return data.products;
    if (renderedSql.includes('from "product_ingredients"')) return data.ingredients;
    if (renderedSql.includes('from "product_packaging"')) return data.packaging;
    if (renderedSql.includes('from "sales_fees"')) return data.fees;
    if (renderedSql.includes('from "market_prices"')) return data.market;
    return [];
  };
  const project = (fields: Record<string, unknown> | undefined, rows: object[]) =>
    fields
      ? rows.map((row) =>
          Object.fromEntries(Object.keys(fields).map((key) => [key, (row as never)[key]])),
        )
      : rows;

  const transaction = {
    select(fields?: Record<string, unknown>) {
      const real = fields ? queryBuilder.select(fields as never) : queryBuilder.select();
      const proxify = (target: object): unknown =>
        new Proxy(target, {
          get(t, property) {
            if (property === "then") {
              return (onfulfilled?: (value: unknown) => unknown) => {
                const rendered = (t as { toSQL(): { sql: string } }).toSQL().sql;
                return Promise.resolve(project(fields, rowsForTable(rendered))).then(onfulfilled);
              };
            }
            const value = Reflect.get(t, property, t);
            if (typeof value !== "function") return value;
            return (...args: unknown[]) => {
              const result = (value as (...a: unknown[]) => unknown).apply(t, args);
              if (result && typeof result === "object") return proxify(result);
              return result;
            };
          },
        });
      return proxify(real as object);
    },
    async execute(fragment: { toSQL(): unknown }) {
      const rendered = dialect.sqlToQuery(fragment as never).sql;
      const rows: Record<string, unknown>[] = [];
      if (rendered.includes('from "product_ingredients"')) {
        rows.push(...data.ingredients.map((row, index) => unionRow(1, "ingredient", row, index)));
      }
      if (rendered.includes('from "product_packaging"')) {
        rows.push(...data.packaging.map((row, index) => unionRow(2, "packaging", row, index)));
      }
      if (rendered.includes('from "sales_fees"')) {
        rows.push(...data.fees.map((row, index) => unionRow(3, "fee", row, index)));
      }
      if (rendered.includes('from "market_prices"')) {
        rows.push(...data.market.map((row, index) => unionRow(4, "market", row, index)));
      }
      return { rows };
    },
  };
  return transaction as unknown as RequestContext["transaction"];
}

function contextFor(cm: number): RequestContext {
  return {
    userId: "user-1",
    tenantId: TENANT_ID,
    roles: ["owner"],
    correlationId: CORRELATION_ID,
    signal: new AbortController().signal,
    transaction: createFakeTransaction({
      products: [productRow(packagePriceFor(cm))],
      ingredients: [ingredientRow(packagePriceFor(cm))],
      packaging: [],
      fees: [],
      market: [],
    }),
  };
}

async function diagnosticViewFor(cm: number): Promise<DiagnosticView> {
  return getDiagnostic(contextFor(cm), {
    productId: PRODUCT_ID,
    nonPercentageVariableUnitCost: null,
    targetContributionRate: null,
  });
}

function routeComponent(route: { options: { component?: unknown } }): () => ReactElement {
  const component = route.options.component;
  if (typeof component !== "function") throw new Error("rota sem componente");
  return component as () => ReactElement;
}

(DiagnosticoRoute as unknown as { useSearch: () => { produto?: string } }).useSearch = () => ({
  produto: undefined,
});

describe("WP-B7 · motor compartilhado: margem não positiva é estado, não entrada inválida", () => {
  for (const edge of EDGES) {
    it(`${edge.name}: status calculado é ${edge.expected}`, () => {
      const result = summaryFor(edge);

      expect(result.status).toBe(edge.expected);
      expect(result.units.status).toBe(edge.expected);
      // A entrada foi aceita: o guard não a rejeita como decimal inválido.
      expect(result.fixedExpenses).toBe("1000.0000");

      if (result.units.status === "unreachable") {
        expect(result.units.reason).toBe("NON_POSITIVE_CONTRIBUTION");
        expect(result.units.rawUnits).toBeNull();
        expect(result.units.roundedUnits).toBeNull();
        expect(result.revenue).toBeNull();
      } else {
        expect(typeof result.units.rawUnits).toBe("string");
      }
    });
  }

  it("margem negativa não é classificada como INVALID_DECIMAL", () => {
    const result = summaryFor(EDGES[0]);

    expect(result.status).not.toBe("invalid");
    expect(JSON.stringify(result)).not.toContain("INVALID_DECIMAL");
    expect(JSON.stringify(result)).not.toContain("contributionMargin");
  });

  it("margem percentual negativa não suprime a classificação (mesmo estado, sem fabricar zero)", () => {
    const result = calculateBreakEvenSummary({
      fixedExpenses: ["1000"],
      price: "25",
      contributionMargin: "-9.15",
      contributionMarginPct: "-36.6",
      desiredProfit: null,
      unitMode: "continuous",
    });

    expect(result.status).toBe("unreachable");
    expect(result.revenue).toBeNull();
    expect(result.units.rawUnits).toBeNull();
  });

  it("NaN/Infinity jamais serializam como número em nenhuma borda (INV-006/007)", () => {
    for (const edge of EDGES) {
      const serialized = JSON.stringify(summaryFor(edge));
      expect(serialized).not.toContain("NaN");
      expect(serialized).not.toContain("Infinity");
    }
  });
});

describe("WP-B7 · concordância dos dois motores (break-even.ts × finance.ts)", () => {
  for (const edge of EDGES) {
    it(`${edge.name}: mesma classificação pelo preço/custo e pela margem crua`, () => {
      const derivedMargin = calculateContributionMargin(
        PRICE,
        packagePriceFor(edge.cm),
        VARIABLE_COST,
      );
      expect(derivedMargin).toBeCloseTo(edge.cm, 10);

      const decimalEngine = summaryFor(edge).units.status;
      const numericEngine = calculateBreakEvenUnits(1000, derivedMargin).status;

      expect(decimalEngine).toBe(edge.expected);
      expect(numericEngine).toBe(edge.expected);
      expect(decimalEngine).toBe(numericEngine);
    });
  }
});

describe("WP-B7 · rota /diagnostico (serviço real getDiagnostic)", () => {
  beforeEach(() => {
    expenseMocks.rows = [{ type: "fixa", amount: FIXED_EXPENSES }];
  });

  for (const edge of EDGES) {
    it(`${edge.name}: produto segue "ok" e o ponto de equilíbrio é ${edge.expected}`, async () => {
      const view = await diagnosticViewFor(edge.cm);

      expect(view.currentStatus).toBe("ok");
      expect(view.currentAnalysis).not.toBeNull();
      expect(view.currentAnalysis?.computation.contributionMargin).toBeCloseTo(edge.cm, 10);
      expect(view.currentAnalysis?.breakEvenUnits.status).toBe(edge.expected);

      const warns = (view.currentAnalysis?.alerts ?? []).filter((alert) =>
        alert.text.includes("não cobre as despesas fixas"),
      );
      expect(warns).toHaveLength(edge.expected === "unreachable" ? 1 : 0);
    });
  }
});

describe("WP-B7 · as duas superfícies exibem a mesma classificação", () => {
  beforeEach(() => {
    expenseMocks.rows = [{ type: "fixa", amount: FIXED_EXPENSES }];
  });

  for (const edge of EDGES) {
    it(`${edge.name}: /ponto-equilibrio e /diagnostico concordam`, async () => {
      surface.expenses = [{ type: "fixa", amount: FIXED_EXPENSES }];
      surface.details = [
        {
          product: { id: PRODUCT_ID, name: "Bolo de Cacau", current_price: String(PRICE) },
          metrics: {
            status: "ok",
            value: {
              contributionMargin: edge.cm,
              contributionMarginPct: edge.pct,
              unitCost: packagePriceFor(edge.cm),
            },
          },
        },
      ];
      surface.products = [{ id: PRODUCT_ID, name: "Bolo de Cacau" }];
      surface.view = await diagnosticViewFor(edge.cm);

      const PontoEquilibrio = routeComponent(PontoEquilibrioRoute);
      const ponto = render(<PontoEquilibrio />);
      const Diagnostico = routeComponent(DiagnosticoRoute);
      const diagnostico = render(<Diagnostico />);

      const unreachable = edge.expected === "unreachable";
      for (const container of [ponto.container, diagnostico.container]) {
        const scope = within(container);
        // O rótulo exato do motor — o texto explicativo estático ("... exibido
        // como Não atingível") não conta: só o VALOR calculado é medido.
        expect(scope.queryAllByText("Erro de cálculo")).toHaveLength(0);
        if (unreachable) {
          expect(scope.getAllByText("Não atingível").length).toBeGreaterThan(0);
        } else {
          expect(scope.queryAllByText("Não atingível")).toHaveLength(0);
          // A superfície renderizou um volume em unidades, não um estado.
          expect(within(container).getAllByText(/^\d+ un\./).length).toBeGreaterThan(0);
        }
      }
      if (unreachable) {
        // /ponto-equilibrio exibe DOIS rótulos derivados do mesmo resultado —
        // volume e faturamento — e ambos mostram o estado, nunca um número
        // fabricado (INV-006/007: "unknown" não vira zero).
        expect(within(ponto.container).getAllByText("Não atingível")).toHaveLength(2);
        expect(within(diagnostico.container).getAllByText("Não atingível")).toHaveLength(1);
      }
    });
  }
});
