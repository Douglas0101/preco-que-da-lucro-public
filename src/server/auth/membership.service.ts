import { and, eq } from "drizzle-orm";
import type { DatabaseTransaction } from "@/db/client.server";
import { sessions, tenantMemberships } from "@/db/schema";
import type { RequestContext } from "@/lib/request-context";

export type TenantRole = "owner" | "admin" | "member";

export async function changeTenantMembershipRole(
  context: RequestContext,
  targetUserId: string,
  role: TenantRole,
): Promise<void> {
  if (!context.roles.includes("owner")) {
    throw new Error("AUTHORIZATION_ERROR");
  }

  // §9.2 — adapter estreita o handle neutro do contexto para a transação do
  // driver; o `RequestContext` que os serviços recebem segue driver-agnostic.
  const tx = context.transaction as DatabaseTransaction;
  const changed = await tx
    .update(tenantMemberships)
    .set({ role, updatedAt: new Date() })
    .where(
      and(
        eq(tenantMemberships.tenantId, context.tenantId),
        eq(tenantMemberships.userId, targetUserId),
      ),
    )
    .returning({ userId: tenantMemberships.userId });

  if (!changed.length) throw new Error("NOT_FOUND");

  // Roles are part of authorization context, so no session issued with the
  // previous role may survive the change.
  await tx.delete(sessions).where(eq(sessions.userId, targetUserId));
}
