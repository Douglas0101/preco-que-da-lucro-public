import { render } from "@testing-library/react";
import axe from "axe-core";
import { describe, expect, it, vi } from "vitest";
import type { ReactElement, ReactNode } from "react";

// Neutraliza os server fns no grafo de import das rotas (mesma estratégia de
// src/test/query-performance.test.ts e src/test/simulation-race.test.tsx): o
// teste exercita APENAS o estado de carregamento, sem BFF.
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

const pendingQuery = {
  isPending: true,
  isError: false,
  isSuccess: false,
  data: undefined,
};

vi.mock("@tanstack/react-query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-query")>();
  return {
    ...actual,
    useQuery: () => pendingQuery,
    useQueries: () => [pendingQuery, pendingQuery],
    useMutation: () => ({ mutate: () => undefined, isPending: false }),
    useQueryClient: () => ({ invalidateQueries: () => Promise.resolve() }),
  };
});

vi.mock("@tanstack/react-router", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@tanstack/react-router")>();
  return {
    ...actual,
    useNavigate: () => () => Promise.resolve(),
    // O cabeçalho de /produtos tem <Link> mesmo no estado de carregamento; a
    // âncora simples evita exigir um <RouterProvider> só para ver o skeleton.
    Link: ({ children, to, ...props }: { children?: ReactNode; to?: string }) => (
      <a href={typeof to === "string" ? to : undefined} {...props}>
        {children}
      </a>
    ),
  };
});

import { LoadingSkeleton } from "@/components/loading-skeleton";
import { Route as DiagnosticoRoute } from "@/routes/_authenticated/diagnostico";
import { Route as InicioRoute } from "@/routes/_authenticated/inicio";
import { Route as PontoEquilibrioRoute } from "@/routes/_authenticated/ponto-equilibrio";
import { Route as ProdutosRoute } from "@/routes/_authenticated/produtos";

/** A rota de arquivo devolve a opção crua `component` — renderizá-la é o gate real. */
function routeComponent(route: { options: { component?: unknown } }): () => ReactElement {
  const component = route.options.component;
  if (typeof component !== "function") throw new Error("rota sem componente");
  return component as () => ReactElement;
}

// Diagnóstico lê a busca da rota (contexto de router); o estado de carregamento
// não depende de `?produto=` e o memo do router não é o alvo deste teste.
(DiagnosticoRoute as unknown as { useSearch: () => { produto?: string } }).useSearch = () => ({
  produto: undefined,
});

function statusRegion(container: HTMLElement): HTMLElement {
  const region = container.querySelector<HTMLElement>('[role="status"]');
  if (!region) throw new Error("região role=status ausente no estado de carregamento");
  return region;
}

function skeletonBody(region: HTMLElement): HTMLElement {
  const body = region.querySelector<HTMLElement>('[aria-hidden="true"]');
  if (!body) throw new Error("corpo visual aria-hidden ausente no esqueleto");
  return body;
}

/** Contrato comum das quatro rotas: anúncio visível a leitor de tela + barras. */
function expectLoadingContract(container: HTMLElement): HTMLElement {
  const region = statusRegion(container);
  const announcement = region.querySelector(".sr-only");
  expect(announcement).toHaveTextContent("Carregando...");
  const body = skeletonBody(region);
  // Existir `.sr-only` na região não basta: dentro da subárvore `aria-hidden` o
  // anúncio é suprimido do leitor de tela e o contrato de §18.5 cai.
  expect(body.contains(announcement)).toBe(false);
  expect(body.querySelectorAll('[data-slot="skeleton"]').length).toBeGreaterThan(0);
  return body;
}

async function expectNoAxeViolations(container: HTMLElement) {
  const result = await axe.run(container, {
    rules: { "color-contrast": { enabled: false } },
  });
  expect(result.violations).toEqual([]);
}

describe("route loading skeletons (§18.5)", () => {
  it("renders the shared loading region with the announcement outside aria-hidden", () => {
    const { container } = render(
      <LoadingSkeleton className="space-y-6">
        <div data-slot="skeleton" className="h-4 w-24" />
      </LoadingSkeleton>,
    );

    const body = expectLoadingContract(container);
    expect(body.className).toContain("space-y-6");
    expect(statusRegion(container).contains(body)).toBe(true);
  });

  it("inicio: renders the 4-column KPI grid geometry and the announcement while loading", async () => {
    const Inicio = routeComponent(InicioRoute);
    const { container } = render(<Inicio />);

    const body = expectLoadingContract(container);
    expect(body.className).toContain("space-y-6");
    expect(body.querySelectorAll(".lg\\:grid-cols-4 > *")).toHaveLength(4);
    expect(body.querySelectorAll(".md\\:grid-cols-2").length).toBeGreaterThan(0);
    expect(container.querySelector("h1")).not.toBeInTheDocument();

    await expectNoAxeViolations(container);
  });

  it("produtos: renders the product list card geometry and the announcement while loading", async () => {
    const Produtos = routeComponent(ProdutosRoute);
    const { container } = render(<Produtos />);

    const body = expectLoadingContract(container);
    expect(body.className).toContain("grid gap-3");
    expect(
      body.querySelectorAll('[data-slot="skeleton"][class*="h-12"][class*="w-12"]'),
    ).toHaveLength(3);

    await expectNoAxeViolations(container);
  });

  it("ponto-equilibrio: renders the metric/break-even card geometry and the announcement while loading", async () => {
    const PontoEquilibrio = routeComponent(PontoEquilibrioRoute);
    const { container } = render(<PontoEquilibrio />);

    const body = expectLoadingContract(container);
    expect(body.className).toContain("space-y-6");
    expect(body.querySelectorAll(".md\\:grid-cols-3 > *")).toHaveLength(3);
    expect(body.querySelectorAll(".md\\:grid-cols-2").length).toBeGreaterThanOrEqual(2);

    await expectNoAxeViolations(container);
  });

  it("diagnostico: renders the KPI grid geometry and the announcement while loading", async () => {
    const Diagnostico = routeComponent(DiagnosticoRoute);
    const { container } = render(<Diagnostico />);

    const body = expectLoadingContract(container);
    expect(body.querySelectorAll(".xl\\:grid-cols-5 > *")).toHaveLength(5);
    expect(body.querySelectorAll(".md\\:grid-cols-2").length).toBeGreaterThanOrEqual(2);

    await expectNoAxeViolations(container);
  });
});
