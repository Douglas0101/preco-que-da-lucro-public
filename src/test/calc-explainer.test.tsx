import { QueryClient, QueryClientProvider, queryOptions } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import Decimal from "decimal.js";
import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

// Neutraliza os server fns no grafo de import das rotas (mesma estratégia de
// simulation-volume-source.test.tsx): a simulação segue pelo motor real e o
// resumo do /inicio vem do fixture abaixo, sem BFF.
vi.mock("@tanstack/react-start", () => ({
  createMiddleware: () => ({
    server: (handler: unknown) => handler,
  }),
  createServerFn: () => {
    const builder = {
      middleware: () => builder,
      validator: () => builder,
      handler: (handler: unknown) => handler,
    };
    return builder;
  },
}));

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    // O /inicio tem <Link> mesmo com o resumo pronto; a âncora simples evita
    // exigir um <RouterProvider> só para ver os cards.
    Link: ({ children, to, ...props }: { children?: ReactNode; to?: string }) => (
      <a href={typeof to === "string" ? to : undefined} {...props}>
        {children}
      </a>
    ),
  };
});

vi.mock("@/lib/financial.functions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/financial.functions")>();
  return { ...actual, saveSimulation: vi.fn() };
});

const dashboard = vi.hoisted(() => ({
  summary: {
    productCount: 3,
    fixedExpenses: "1250.0000",
    bestProduct: { name: "Bolo de cenoura", cmPct: "50.000000" },
    hasInvalidCalculation: false,
    incompleteProductCount: 1,
    alerts: [],
    period: "month",
    sales: { revenue: "4800.0000", count: 12 },
  },
}));

vi.mock("@/lib/dashboard.functions", () => ({
  getDashboardSummary: async () => dashboard.summary,
}));

const PRODUCT_ID = "5f0f2c8e-0000-4000-8000-000000000001";

const productDetail = {
  product: {
    id: PRODUCT_ID,
    name: "Bolo de cenoura",
    current_price: "10",
    tax_rate: "0.1",
  },
  ingredients: [],
  packaging: [],
  fees: [],
  market: null,
  metrics: {
    status: "ok",
    value: {
      recipeCost: 3,
      packagingCost: 1,
      unitCost: 4,
      variableCost: 1,
      contributionMargin: 5,
      contributionMarginPct: 50,
    },
    warnings: [],
  },
  completeness: { status: "complete", missing: [] },
};

// Só os read models de apoio da simulação são fixados; `dashboardSummaryQueryOptions`
// e `financialSimulationQueryOptions` seguem reais (o motor calcula de verdade).
vi.mock("@/lib/query-options", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/query-options")>();
  return {
    ...actual,
    productsWithMetricsQueryOptions: () =>
      queryOptions({ queryKey: ["test", "products"], queryFn: async () => [productDetail] }),
    expensesQueryOptions: () =>
      queryOptions({
        queryKey: ["test", "expenses"],
        queryFn: async () => [{ type: "fixa", amount: "50" }],
      }),
    savedSimulationsQueryOptions: () =>
      queryOptions({ queryKey: ["test", "saved"], queryFn: async () => [] }),
  };
});

import { CalcExplainer } from "@/components/ui/calc-explainer";
import { brl, pct } from "@/lib/format";
import {
  calculateContributionMargin,
  calculateContributionMarginPct,
  calculateScenario,
  calculateVariableCost,
} from "@/lib/finance";
import {
  CONTRIBUTION_MARGIN_PCT_FORMULA,
  SCENARIO_STEP_SPECS,
  scenarioExplanation,
  type ScenarioExplainInput,
  type ScenarioStepField,
} from "@/lib/calc-explanation";
import { runFinancialSimulation } from "@/server/services/financial.service";
import { Route as InicioRoute } from "@/routes/_authenticated/inicio";
import {
  Route as SimulacoesRoute,
  VOLUME_ORIGIN_EXPLANATION,
} from "@/routes/_authenticated/simulacoes";

async function expectNoAxeViolations(container: HTMLElement) {
  const result = await axe.run(container, {
    rules: { "color-contrast": { enabled: false } },
  });
  expect(result.violations).toEqual([]);
}

/**
 * O `Intl` pt-BR separa "R$" do número com NBSP; as asserções de texto usam
 * espaço comum.
 */
function normalizedText(element: Element | null): string {
  return (element?.textContent ?? "").replace(/\u00a0/g, " ");
}

/**
 * `summary` não tem papel ARIA na tabela do `aria-query` (o `getByRole` não o
 * encontra); o resumo do disclosure é lido pelo elemento nativo.
 */
function explainerSummaries(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>("details > summary")).filter(
    (summary) => summary.textContent?.trim() === "Como calculamos?",
  );
}

function renderWithQueryClient(node: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{node}</QueryClientProvider>);
}

/** A rota de arquivo devolve a opção crua `component` — renderizá-la é o gate real. */
function routeComponent(route: { options: { component?: unknown } }): () => ReactElement {
  const component = route.options.component;
  if (typeof component !== "function") throw new Error("rota sem componente");
  return component as () => ReactElement;
}

const Inicio = routeComponent(InicioRoute);
const Simulacoes = routeComponent(SimulacoesRoute);

describe("CalcExplainer — revelação alcançável por teclado (§18.3)", () => {
  it("Tab alcança o resumo e o foco continua nele depois de revelar e esconder", async () => {
    const user = userEvent.setup();
    const view = render(
      <CalcExplainer>
        <p>preço × volume</p>
      </CalcExplainer>,
    );
    const [summary] = explainerSummaries(view.container);
    const details = summary.closest("details") as HTMLDetailsElement;

    // Fechado por padrão; o disclosure é nativo (sem handler nem estado próprio).
    expect(details.open).toBe(false);
    expect(summary.tagName).toBe("SUMMARY");

    let reachedByTab = false;
    for (let press = 0; press < 10 && !reachedByTab; press += 1) {
      await user.tab();
      reachedByTab = document.activeElement === summary;
    }
    expect(reachedByTab).toBe(true);
    expect(summary).toHaveFocus();

    // jsdom não implementa a ativação de teclado do <summary> (o navegador
    // dispara um click sintético por baixo); o reveal é exercitado pelo mesmo
    // caminho que o navegador usa e o foco é conferido logo depois dele.
    await user.click(summary);
    expect(details.open).toBe(true);
    expect(summary).toHaveFocus();

    await user.click(summary);
    expect(details.open).toBe(false);
    expect(summary).toHaveFocus();
  });

  it("passa no axe com o conteúdo revelado", async () => {
    const user = userEvent.setup();
    const view = render(
      <CalcExplainer>
        <p>
          <span className="font-medium">Fórmula:</span> preço × volume.
        </p>
      </CalcExplainer>,
    );
    await user.click(explainerSummaries(view.container)[0]);

    await expectNoAxeViolations(view.container);
  });
});

describe("/inicio — explicação nos quatro KPIs e no destaque de margem (§18.3)", () => {
  it("cada KPI e o destaque de margem têm o próprio «Como calculamos?»", async () => {
    const user = userEvent.setup();
    const view = renderWithQueryClient(<Inicio />);
    await screen.findByText("Bolo de cenoura");

    const summaries = explainerSummaries(view.container);
    expect(summaries).toHaveLength(5);
    for (const summary of summaries) {
      const details = summary.closest("details") as HTMLDetailsElement;
      expect(details.querySelector("div")?.textContent?.trim()).toBeTruthy();
    }

    const text = normalizedText(view.container);
    expect(text).toContain("Contagem direta dos produtos cadastrados");
    expect(text).toContain("soma das despesas cadastradas com tipo «fixa»");
    expect(text).toContain("soma das vendas registradas no período selecionado");
    expect(text).toContain("mix real de vendas");
    // A fórmula do destaque é a MESMA string presa ao motor pelo teste de paridade.
    expect(text).toContain(CONTRIBUTION_MARGIN_PCT_FORMULA);

    await user.click(summaries[0]);
    await expectNoAxeViolations(view.container);
  });

  it("sem vendas no período explica o «—» em vez de mostrar margem inventada", async () => {
    dashboard.summary = { ...dashboard.summary, sales: { revenue: "0.0000", count: 0 } };
    try {
      const view = renderWithQueryClient(<Inicio />);
      await screen.findByText("Bolo de cenoura");

      const text = normalizedText(view.container);
      expect(text).toContain("Sem vendas registradas no período selecionado");
      expect(text).toContain("Vendas da simulação e estimativas não entram neste total.");
      expect(explainerSummaries(view.container)).toHaveLength(5);
    } finally {
      dashboard.summary = { ...dashboard.summary, sales: { revenue: "4800.0000", count: 12 } };
    }
  });
});

describe("paridade com o motor (§18.3)", () => {
  const input: ScenarioExplainInput = {
    price: 10,
    unitCost: 4,
    taxRate: 10,
    fees: [],
    fixedExpenses: 50,
    volume: 20,
  };

  const scenario = calculateScenario({ ...input, volumeSource: "manual_simulation" });

  function okScenario() {
    if (scenario.status !== "ok") throw new Error(`cenário não calculou: ${scenario.status}`);
    return scenario.value;
  }

  /**
   * Transcrição das strings de `SCENARIO_STEP_SPECS` em aritmética de Decimal —
   * independente do motor, é ela que denuncia uma fórmula que ficou para trás.
   */
  function formulaChain(echo: ReturnType<typeof okScenario>) {
    const feeRate = input.fees.reduce((sum, fee) => sum.plus(fee.percentage ?? 0), new Decimal(0));
    return {
      variableCost: new Decimal(input.price).mul(new Decimal(input.taxRate).plus(feeRate)).div(100),
      contributionMargin: new Decimal(input.price).minus(input.unitCost).minus(echo.variableCost),
      contributionMarginPct: new Decimal(echo.contributionMargin).div(input.price).mul(100),
      revenue: new Decimal(input.price).mul(input.volume),
      totalVariable: new Decimal(input.unitCost).plus(echo.variableCost).mul(input.volume),
      totalContribution: new Decimal(echo.contributionMargin).mul(input.volume),
      result: new Decimal(echo.totalContribution).minus(input.fixedExpenses),
    };
  }

  it("o motor aplica a cadeia na ordem explicada (mesmas funções exportadas)", () => {
    const echo = okScenario();

    expect(calculateVariableCost(input.price, input.taxRate, input.fees)).toBe(echo.variableCost);
    expect(calculateContributionMargin(input.price, input.unitCost, echo.variableCost)).toBe(
      echo.contributionMargin,
    );
    expect(calculateContributionMarginPct(input.price, echo.contributionMargin)).toBe(
      echo.contributionMarginPct,
    );
  });

  it("cada fórmula declarada reproduz o valor que o motor devolveu", () => {
    const echo = okScenario();
    const chain = formulaChain(echo);

    for (const spec of SCENARIO_STEP_SPECS) {
      const expected = chain[spec.field];
      expect(new Decimal(echo[spec.field]).eq(expected), `passo ${spec.field}`).toBe(true);
    }
  });

  it("exibe o eco do motor, nunca um número reescrito à mão", () => {
    const echo = okScenario();
    const steps = scenarioExplanation({ ...echo });

    for (const step of steps) {
      const engineValue = echo[step.field];
      expect(step.value).toBe(
        step.field === "contributionMarginPct" ? pct(engineValue) : brl(engineValue),
      );
    }
    expect(steps.map((step) => step.field)).toEqual(SCENARIO_STEP_SPECS.map((spec) => spec.field));
  });

  it("o eco serializado do BFF formata igual ao eco cru do motor", () => {
    const serialized = runFinancialSimulation({
      price: "10",
      unitCost: "4",
      taxRate: "10",
      fees: [],
      fixedExpenses: "50",
      volume: "20",
      volumeSource: "forecast",
    });
    if (serialized.status !== "ok") throw new Error("BFF não calculou o cenário");

    expect(scenarioExplanation(serialized.value)).toEqual(
      scenarioExplanation({ ...okScenario(), volumeSource: "forecast" }),
    );
  });

  it("cobre todo campo do eco do motor, ou declara por que não cobre", () => {
    const serialized = runFinancialSimulation({
      price: "10",
      unitCost: "4",
      taxRate: "10",
      fees: [],
      fixedExpenses: "50",
      volume: "20",
      volumeSource: "manual_simulation",
    });
    if (serialized.status !== "ok") throw new Error("BFF não calculou o cenário");

    const explained = new Set<ScenarioStepField>(SCENARIO_STEP_SPECS.map((spec) => spec.field));
    for (const key of Object.keys(serialized.value)) {
      expect(
        explained.has(key as ScenarioStepField) || key in NOT_EXPLAINED_HERE,
        `campo do motor sem explicação declarada: ${key}`,
      ).toBe(true);
    }
    for (const key of Object.keys(NOT_EXPLAINED_HERE)) {
      expect(serialized.value, `motivo declarado para campo inexistente: ${key}`).toHaveProperty(
        key,
      );
    }
  });

  it("a fórmula do KPI de margem de /inicio é a do passo preso ao motor", () => {
    const pctStep = SCENARIO_STEP_SPECS.find((spec) => spec.field === "contributionMarginPct");
    expect(pctStep?.formula).toBe(CONTRIBUTION_MARGIN_PCT_FORMULA);
  });
});

/**
 * Campos do eco do motor que o "Como calculamos?" do resultado NÃO repete, com
 * o motivo. Um campo novo no eco serializado pelo BFF (`DecimalScenarioResult`
 * de `runFinancialSimulation`) sem decisão registrada aqui derruba o teste de
 * cobertura acima; um campo que exista só no motor (`ScenarioResult` de
 * `calculateScenario`, que o BFF ecoa por lista explícita de campos) não passa
 * por este lock.
 */
const NOT_EXPLAINED_HERE: Record<string, string> = {
  price: "entrada informada no formulário",
  unitCost: "entrada informada no formulário",
  volume: "entrada informada no formulário; a origem tem texto próprio",
  volumeSource: "origem do volume, explicada em texto próprio no mesmo bloco",
  breakEvenUnits: "explicado em /ponto-equilibrio; não é exibido no resultado da simulação",
  breakEvenRevenue: "explicado em /ponto-equilibrio; não é exibido no resultado da simulação",
  resultSign: "sinal do resultado, usado só para colorir a linha",
};

describe("resultado da simulação — fórmulas e origem do volume (§18.3)", () => {
  async function renderSimulacoes() {
    const user = userEvent.setup();
    const view = renderWithQueryClient(<Simulacoes />);
    await screen.findByRole("group", { name: "Origem do volume simulado" });
    return { user, view };
  }

  it("forecast: mostra as fórmulas do motor e descreve a projeção sem prometer previsão estatística", async () => {
    const { user, view } = await renderSimulacoes();

    await user.click(screen.getByRole("radio", { name: "Estimativa (projeção)" }));
    await user.type(screen.getByLabelText("Vendas estimadas (unidades)"), "20");

    const summary = await waitFor(
      () => {
        const [found] = explainerSummaries(view.container);
        if (!found) throw new Error("explicação do resultado ainda não apareceu");
        return found;
      },
      { timeout: 5_000 },
    );
    await user.click(summary);

    const explainer = summary.closest("details") as HTMLDetailsElement;
    expect(explainer.open).toBe(true);
    const text = normalizedText(explainer);

    // Valores do cenário 10 / 4 / 10% / 20 un. / 50 de despesa fixa, calculados
    // pelo motor de verdade — a explicação não inventa número.
    expect(text).toContain("Custo variável unitário: preço × (imposto + taxas) ÷ 100 = R$ 1,00");
    expect(text).toContain(
      "Margem de contribuição unitária: preço − custo unitário − custo variável unitário = R$ 5,00",
    );
    expect(text).toContain(`${CONTRIBUTION_MARGIN_PCT_FORMULA} = 50,00%`);
    expect(text).toContain("Faturamento: preço × volume = R$ 200,00");
    expect(text).toContain(
      "Margem de contribuição total: margem de contribuição unitária × volume = R$ 100,00",
    );
    expect(text).toContain("margem de contribuição total − despesas fixas no escopo = R$ 50,00");

    // A origem da projeção é o volume INFORMADO por quem usa o app; o motor não
    // faz previsão estatística (§18.1) e a explicação não pode sugerir que faça.
    expect(text).toContain(VOLUME_ORIGIN_EXPLANATION.forecast);
    expect(text).toContain("não é previsão estatística");
    expect(screen.getByText("Estimativa informada (projeção)")).toBeInTheDocument();

    await expectNoAxeViolations(view.container);
  });

  it("simulação manual: a mesma matemática, com o volume declarado hipotético", async () => {
    const { user, view } = await renderSimulacoes();

    await user.type(screen.getByLabelText("Vendas simuladas (unidades)"), "20");

    const summary = await waitFor(
      () => {
        const [found] = explainerSummaries(view.container);
        if (!found) throw new Error("explicação do resultado ainda não apareceu");
        return found;
      },
      { timeout: 5_000 },
    );
    await user.click(summary);

    const text = normalizedText(summary.closest("details"));
    expect(text).toContain(VOLUME_ORIGIN_EXPLANATION.manual_simulation);
    expect(text).toContain("Faturamento: preço × volume = R$ 200,00");
    expect(screen.getByText("Informado manualmente")).toBeInTheDocument();

    await waitFor(() =>
      expect(
        screen.getByText("Resultado operacional simulado dentro do escopo informado"),
      ).toBeInTheDocument(),
    );
  });
});
