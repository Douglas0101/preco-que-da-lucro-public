import { QueryClient } from "@tanstack/react-query";
import { createRouter } from "@tanstack/react-router";
import { createIsomorphicFn } from "@tanstack/react-start";
import { routeTree } from "./routeTree.gen";
import { initWebVitals } from "@/lib/web-vitals.client";
import { OPERATIONAL_STALE_TIME } from "@/lib/query-stale-time";

// router.tsx is also part of the SSR graph; the isomorphic wrapper keeps the
// web-vitals collector out of the server bundle (import protection).
const initWebVitalsOnClient = createIsomorphicFn().client(initWebVitals);
initWebVitalsOnClient();

export const getRouter = () => {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: {
        // Piso conservador para dado financeiro multitenant (INV-002/010);
        // staleTimes agressivos ficam por query key em query-options.ts e as
        // invalidações pós-escrita permanecem explícitas.
        retry: false,
        staleTime: OPERATIONAL_STALE_TIME,
      },
    },
  });

  const router = createRouter({
    routeTree,
    context: { queryClient },
    scrollRestoration: true,
    defaultPreload: "intent",
    // Coerente com a política de staleTime: preloads não são marcados stale
    // imediatamente (defaultPreloadStaleTime: 0 era footgun de refetch).
    defaultPreloadStaleTime: OPERATIONAL_STALE_TIME,
  });

  return router;
};
