import { QueryClient, QueryClientProvider, queryOptions } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

import { runFinancialSimulation } from "@/server/services/financial.service";
import {
  buildSimulationInput,
  Route as SimulacoesRoute,
  VOLUME_SOURCE_DISPLAY,
  type ProductBaseline,
} from "@/routes/_authenticated/simulacoes";
import { saveSimulation } from "@/lib/financial.functions";

// Mesma estratégia de simulation-race.test.tsx / query-performance.test.ts:
// neutraliza os server fns no grafo de import do módulo da rota, de modo que
// `runSimulation` executa o motor real (não há fetch em jsdom).
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

vi.mock("@/lib/financial.functions", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/financial.functions")>();
  return { ...actual, saveSimulation: vi.fn() };
});

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

const fixedExpense = { type: "fixa", amount: "50" };

// Só os read models de apoio são fixados; a simulação segue pela opção real
// (`financialSimulationQueryOptions` → `runSimulation` → motor de `finance.ts`).
vi.mock("@/lib/query-options", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/query-options")>();
  return {
    ...actual,
    productsWithMetricsQueryOptions: () =>
      queryOptions({ queryKey: ["test", "products"], queryFn: async () => [productDetail] }),
    expensesQueryOptions: () =>
      queryOptions({ queryKey: ["test", "expenses"], queryFn: async () => [fixedExpense] }),
    savedSimulationsQueryOptions: () =>
      queryOptions({ queryKey: ["test", "saved"], queryFn: async () => [] }),
  };
});

const base: ProductBaseline = {
  recipeCost: 3,
  packagingCost: 1,
  unitCost: 4,
  variableCost: 1,
  contributionMargin: 5,
  contributionMarginPct: 50,
  name: "Bolo de cenoura",
  price: 10,
  taxRate: 10,
  fees: [],
};

const form = {
  productId: PRODUCT_ID,
  price: "10",
  unitCost: "4",
  fixed: "50",
  volume: "20",
};

describe("buildSimulationInput por origem de volume (§18.1)", () => {
  it("envia manual_simulation para o cenário informado à mão", () => {
    const input = buildSimulationInput({ ...form, volumeSource: "manual_simulation" }, base);

    expect(input.volumeSource).toBe("manual_simulation");
    expect(input.volume).toBe("20");
    expect(input.taxRate).toBe("10");
  });

  it("envia forecast quando o usuário escolhe a estimativa — sem fallback silencioso", () => {
    const manual = buildSimulationInput({ ...form, volumeSource: "manual_simulation" }, base);
    const forecastInput = buildSimulationInput({ ...form, volumeSource: "forecast" }, base);

    expect(forecastInput.volumeSource).toBe("forecast");
    expect(forecastInput.volume).toBe("20");
    // Só a origem muda: nada é convertido para manual_simulation no caminho.
    expect({ ...forecastInput, volumeSource: "manual_simulation" }).toEqual(manual);
  });

  it("mantém campo vazio como null também na estimativa (unknown ≠ zero)", () => {
    const input = buildSimulationInput({ ...form, volume: "", volumeSource: "forecast" }, base);

    expect(input.volume).toBeNull();
    expect(input.volumeSource).toBe("forecast");
  });
});

describe("forecast computa no motor (§18.1)", () => {
  const params = {
    price: "10",
    unitCost: "4",
    fixedExpenses: "50",
    volume: "20",
    taxRate: "10",
    fees: [],
  };

  it("devolve o mesmo cenário calculado, mudando apenas a origem declarada do volume", () => {
    const manual = runFinancialSimulation({ ...params, volumeSource: "manual_simulation" });
    const forecast = runFinancialSimulation({ ...params, volumeSource: "forecast" });

    expect(manual.status).toBe("ok");
    expect(forecast.status).toBe("ok");
    if (manual.status !== "ok" || forecast.status !== "ok") return;
    expect(forecast.value.volumeSource).toBe("forecast");
    expect(manual.value.volumeSource).toBe("manual_simulation");
    const { volumeSource: _manualSource, ...manualNumbers } = manual.value;
    const { volumeSource: _forecastSource, ...forecastNumbers } = forecast.value;
    expect(forecastNumbers).toEqual(manualNumbers);
  });
});

/** A rota de arquivo devolve a opção crua `component` — o componente da rota não
 * é exportado para não desligar o code splitting (§17.6). */
function routeComponent(route: { options: { component?: unknown } }): () => ReactElement {
  const component = route.options.component;
  if (typeof component !== "function") throw new Error("rota sem componente");
  return component as () => ReactElement;
}

const Simulacoes = routeComponent(SimulacoesRoute);

async function renderSimulacoes() {
  const user = userEvent.setup();
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const view = render(
    <QueryClientProvider client={client}>
      <Simulacoes />
    </QueryClientProvider>,
  );

  const group = await screen.findByRole("group", { name: "Origem do volume simulado" });
  return { user, view, group };
}

function volumeSourceRadios() {
  return {
    manual: screen.getByRole("radio", { name: "Simulação manual" }),
    forecast: screen.getByRole("radio", { name: "Estimativa (projeção)" }),
  };
}

describe("toggle acessível de origem do volume (§18.1)", () => {
  it("expõe o grupo, o rótulo e o estado de cada opção (teclado alcança o radio marcado)", async () => {
    const { user, group } = await renderSimulacoes();
    const { manual, forecast } = volumeSourceRadios();

    expect(group.tagName).toBe("FIELDSET");
    expect(manual).toBeChecked();
    expect(forecast).not.toBeChecked();
    // Mesmo `name`: o browser trata os dois como um grupo (setas movem a escolha).
    expect(manual).toHaveAttribute("name", "simulacao-origem-volume");
    expect(forecast).toHaveAttribute("name", "simulacao-origem-volume");
    expect(manual).toHaveAccessibleDescription(VOLUME_SOURCE_DISPLAY.manual_simulation.optionHint);
    expect(forecast).toHaveAccessibleDescription(VOLUME_SOURCE_DISPLAY.forecast.optionHint);

    let reachedByTab = false;
    for (let press = 0; press < 40 && !reachedByTab; press += 1) {
      await user.tab();
      reachedByTab = document.activeElement === manual;
    }
    expect(reachedByTab).toBe(true);

    // Setas dentro do grupo: o radio que tem foco muda a escolha do grupo
    // inteiro (sem clique e sem handler de teclado escrito à mão).
    await user.keyboard("{ArrowRight}");
    expect(forecast).toBeChecked();
    expect(manual).not.toBeChecked();
    expect(forecast).toHaveFocus();

    await user.keyboard("{ArrowLeft}");
    expect(manual).toBeChecked();
    expect(forecast).not.toBeChecked();
    expect(manual).toHaveFocus();
  });

  it("anuncia a estimativa e bloqueia o salvamento com o motivo declarado", async () => {
    const { user } = await renderSimulacoes();
    const { manual, forecast } = volumeSourceRadios();

    await user.click(forecast);

    expect(forecast).toBeChecked();
    expect(screen.getByText("Estimativa de volume")).toBeInTheDocument();
    expect(screen.getByText("Estimativa")).toHaveClass("uppercase");
    // O campo do volume segue a origem: numa projeção ele não é “simulado”.
    expect(screen.getByLabelText("Vendas estimadas (unidades)")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Vendas estimadas (unidades)"), "20");

    // O volume da estimativa atravessa o motor (origem do volume ecoada por ele).
    await waitFor(
      () => expect(screen.getByText("Estimativa informada (projeção)")).toBeInTheDocument(),
      { timeout: 5_000 },
    );
    expect(screen.getByText("Faturamento simulado")).toBeInTheDocument();

    await user.type(screen.getByLabelText("Nome da simulação"), "Projeção Q4");
    const save = screen.getByRole("button", { name: "Salvar simulação" });
    expect(save).toBeDisabled();
    expect(save).toHaveAccessibleDescription(/persistência aceita apenas a origem/i);
    expect(screen.getByText(/guardar projeções está previsto para a v2/i)).toBeInTheDocument();

    await user.click(save);
    expect(vi.mocked(saveSimulation)).not.toHaveBeenCalled();

    // Voltar para manual reabilita o salvamento — a origem, não o nome, decide.
    await user.click(manual);
    expect(manual).toBeChecked();
    await waitFor(() => expect(screen.getByText("Informado manualmente")).toBeInTheDocument(), {
      timeout: 5_000,
    });
    expect(screen.getByText("Simulação")).toHaveClass("uppercase");
    expect(screen.getByRole("button", { name: "Salvar simulação" })).toBeEnabled();
  });

  it("não tem violações de acessibilidade com a estimativa selecionada", async () => {
    const { user, view } = await renderSimulacoes();
    const { forecast } = volumeSourceRadios();

    await user.click(forecast);
    await user.type(screen.getByLabelText("Vendas estimadas (unidades)"), "20");
    const save = await screen.findByRole(
      "button",
      { name: "Salvar simulação" },
      { timeout: 5_000 },
    );
    await user.type(screen.getByLabelText("Nome da simulação"), "Projeção Q4");
    expect(save).toBeDisabled();

    const result = await axe.run(view.container, {
      rules: { "color-contrast": { enabled: false } },
    });
    expect(result.violations).toEqual([]);
  });
});
