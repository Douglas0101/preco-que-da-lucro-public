// Provider de sessão compartilhado: este módulo é intencionalmente misto
// (query + provider + hook compartilham a mesma key de get-session).
/* eslint-disable react-refresh/only-export-components */
import { queryOptions, useQuery } from "@tanstack/react-query";
import { createContext, useContext, type ReactNode } from "react";
import { authClient } from "@/lib/auth-client";

/**
 * Provider de sessão compartilhado: get-session único do app.
 *
 * O loader do layout _authenticated, o AppShell e a landing (/) consomem a
 * MESMA query (key ["auth","session"]) — elimina os RTs duplicados de
 * get-session a cada mount/navegação (antes: beforeLoad + AppShell + landing).
 *
 * A sessão negativa NÃO é cacheada: a queryFn lança SessionUnavailableError
 * quando não há usuário, então ensureQueryData/fetchQuery sempre refazem a
 * checagem após um login (o cache nunca retém "não autenticado").
 */
export const SESSION_STALE_TIME = 5 * 60_000;

export class SessionUnavailableError extends Error {
  constructor() {
    super("Sessão indisponível para o usuário atual.");
    this.name = "SessionUnavailableError";
  }
}

async function fetchSessionUser() {
  const { data, error } = await authClient.getSession();
  if (error || !data?.user) throw new SessionUnavailableError();
  return data.user;
}

export type SessionUser = Awaited<ReturnType<typeof fetchSessionUser>>;

export const sessionQueryOptions = () =>
  queryOptions({
    queryKey: ["auth", "session"] as const,
    queryFn: fetchSessionUser,
    staleTime: SESSION_STALE_TIME,
    retry: false,
  });

const SessionContext = createContext<SessionUser | null>(null);

export function SessionProvider({ children }: { children: ReactNode }) {
  const sessionQuery = useQuery(sessionQueryOptions());
  return (
    <SessionContext.Provider value={sessionQuery.data ?? null}>{children}</SessionContext.Provider>
  );
}

export function useSessionUser(): SessionUser | null {
  return useContext(SessionContext);
}
