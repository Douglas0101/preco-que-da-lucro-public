import type { RequestContext } from "@/lib/request-context";

/** Shared minimal RequestContext for service authorization tests. */
export function contextWithRole(role: string): RequestContext {
  return {
    userId: "user-1",
    tenantId: "50000000-0000-4000-8000-000000000005",
    roles: [role],
    correlationId: "60000000-0000-4000-8000-000000000006",
    signal: new AbortController().signal,
    transaction: {} as RequestContext["transaction"],
  };
}
