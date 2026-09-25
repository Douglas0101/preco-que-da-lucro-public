import { createFileRoute, Outlet, redirect } from "@tanstack/react-router";
import { AppShell } from "@/components/app-shell";
import { SessionProvider, sessionQueryOptions } from "@/lib/session-context";

function AuthenticatedPending() {
  return (
    <div className="min-h-screen bg-background" aria-busy="true">
      <output className="grid min-h-screen place-items-center text-muted-foreground">
        Carregando...
      </output>
    </div>
  );
}

export const Route = createFileRoute("/_authenticated")({
  ssr: false,
  // Loader NÃO-bloqueante (T2): a checagem de sessão usa ensureQueryData na
  // query compartilhada ["auth","session"] (get-session único, T6). A
  // navegação renderiza pendingComponent durante o fetch; redirect a /auth
  // continua funcionando quando a sessão não existe (comportamento testado).
  // A autorização real continua server-side nos server fns (INV-002/010):
  // este loader é gate de UX/prefetch, não fronteira de segurança.
  loader: async ({ context, location }) => {
    try {
      await context.queryClient.ensureQueryData(sessionQueryOptions());
    } catch {
      throw redirect({
        to: "/auth",
        search: { redirect: `${location.pathname}${location.searchStr}${location.hash}` },
      });
    }
  },
  pendingComponent: AuthenticatedPending,
  component: () => (
    <SessionProvider>
      <AppShell>
        <Outlet />
      </AppShell>
    </SessionProvider>
  ),
});
