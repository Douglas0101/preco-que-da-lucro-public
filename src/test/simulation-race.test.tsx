import { render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  SIMULATION_DEBOUNCE_MS,
  buildSimulationInput,
  createDebounceScheduler,
} from "@/routes/_authenticated/simulacoes";
import {
  financialSimulationQueryOptions,
  queryKeys,
  type FinancialSimulationInput,
} from "@/lib/query-options";
import type { ProductBaseline } from "@/routes/_authenticated/simulacoes";

type SimulationResult = Awaited<
  ReturnType<NonNullable<ReturnType<typeof financialSimulationQueryOptions>["queryFn"]>>
>;

// Mesma estratégia de query-performance.test.ts: neutraliza os server fns no
// grafo de import do módulo da rota.
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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const inputA: FinancialSimulationInput = {
  price: "10",
  unitCost: "4",
  fixedExpenses: "100",
  volume: "20",
  taxRate: null,
  fees: [],
  volumeSource: "manual_simulation",
};
const inputB: FinancialSimulationInput = { ...inputA, price: "11" };

function RaceHarness({
  input,
  fetchImpl,
}: Readonly<{
  input: FinancialSimulationInput;
  fetchImpl: (input: FinancialSimulationInput) => Promise<SimulationResult>;
}>) {
  const query = useQuery({
    ...financialSimulationQueryOptions(input),
    queryFn: () => fetchImpl(input),
  });
  return <output data-testid="sim-output">{JSON.stringify(query.data ?? null)}</output>;
}

describe("race da simulação debounced (T5)", () => {
  it("resposta lenta antiga nunca sobrescreve a exibição atual", async () => {
    const queryClient = new QueryClient();
    const deferredA = createDeferred<SimulationResult>();
    const deferredB = createDeferred<SimulationResult>();
    const fetchImpl = vi.fn((input: FinancialSimulationInput) =>
      input.price === inputA.price ? deferredA.promise : deferredB.promise,
    );

    const view = render(
      <QueryClientProvider client={queryClient}>
        <RaceHarness input={inputA} fetchImpl={fetchImpl} />
      </QueryClientProvider>,
    );

    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId("sim-output")).toHaveTextContent("null");

    // usuário digita: novo input → nova cache key → nova query
    view.rerender(
      <QueryClientProvider client={queryClient}>
        <RaceHarness input={inputB} fetchImpl={fetchImpl} />
      </QueryClientProvider>,
    );
    await waitFor(() => expect(fetchImpl).toHaveBeenCalledTimes(2));

    // resposta NOVA chega primeiro
    deferredB.resolve({ payload: "B" } as unknown as SimulationResult);
    await waitFor(() => expect(screen.getByTestId("sim-output")).toHaveTextContent("B"));

    // resposta LENTA ANTIGA chega depois — deve ser descartada
    deferredA.resolve({ payload: "A-STALE" } as unknown as SimulationResult);
    await waitFor(() =>
      expect(queryClient.getQueryData(queryKeys.financialSimulation(inputA))).toEqual({
        payload: "A-STALE",
      }),
    );
    expect(screen.getByTestId("sim-output")).toHaveTextContent("B");
    expect(screen.getByTestId("sim-output")).not.toHaveTextContent("A-STALE");

    // o dado antigo fica isolado na própria cache key (nunca vira exibição)
    expect(queryClient.getQueryData(queryKeys.financialSimulation(inputB))).toEqual({
      payload: "B",
    });
  });
});

describe("createDebounceScheduler (guarda de geração do T5)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("aplica o agendamento somente após o delay completo", () => {
    vi.useFakeTimers();
    const applied: string[] = [];
    const scheduler = createDebounceScheduler(SIMULATION_DEBOUNCE_MS);

    scheduler.schedule(() => applied.push("a"));
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS - 1);
    expect(applied).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(applied).toEqual(["a"]);
  });

  it("agendamento antigo é descartado quando existe geração mais nova", () => {
    vi.useFakeTimers();
    const applied: string[] = [];
    const scheduler = createDebounceScheduler(SIMULATION_DEBOUNCE_MS);

    scheduler.schedule(() => applied.push("antiga"));
    scheduler.schedule(() => applied.push("atual"));
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS);

    expect(applied).toEqual(["atual"]);
  });

  it("o cleanup cancela o agendamento pendente (uso pelo effect)", () => {
    vi.useFakeTimers();
    const applied: string[] = [];
    const scheduler = createDebounceScheduler(SIMULATION_DEBOUNCE_MS);

    const cancel = scheduler.schedule(() => applied.push("a"));
    cancel();
    vi.advanceTimersByTime(SIMULATION_DEBOUNCE_MS);

    expect(applied).toEqual([]);
  });

  it("usa 400ms de debounce", () => {
    expect(SIMULATION_DEBOUNCE_MS).toBe(400);
  });
});

describe("buildSimulationInput (unknown ≠ zero, INV-006/009)", () => {
  it("campo viro vira null, nunca zero; vírgula é normalizada", () => {
    const input = buildSimulationInput(
      {
        productId: "p1",
        price: "12,50",
        unitCost: "",
        fixed: "100,00",
        volume: "",
        volumeSource: "manual_simulation",
      },
      null,
    );
    expect(input).toEqual({
      price: "12.50",
      unitCost: null,
      fixedExpenses: "100.00",
      volume: null,
      taxRate: null,
      fees: [],
      volumeSource: "manual_simulation",
    });
  });

  it("deriva imposto e taxas do produto base", () => {
    const base = {
      recipeCost: 3,
      packagingCost: 1,
      unitCost: 4,
      variableCost: 5,
      contributionMargin: 6,
      contributionMarginPct: 60,
      name: "P",
      price: 10,
      taxRate: 8,
      fees: [{ percentage: 2.99 }],
    } satisfies ProductBaseline;
    const input = buildSimulationInput(
      {
        productId: "p1",
        price: "10",
        unitCost: "4",
        fixed: "100",
        volume: "20",
        volumeSource: "manual_simulation",
      },
      base,
    );
    expect(input.taxRate).toBe("8");
    expect(input.fees).toEqual([{ percentage: "2.99" }]);
  });
});
