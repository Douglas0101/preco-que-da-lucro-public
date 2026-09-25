import { tenantMemberships, tenants, profiles } from "@/db/schema";
import { withTenantTransaction } from "@/db/client.server";

export async function createPersonalTenantForUser(user: {
  id: string;
  name: string;
  email: string;
}): Promise<string> {
  const tenantId = crypto.randomUUID();
  await withTenantTransaction(
    { userId: user.id, tenantId, roles: ["owner"] },
    async (transaction) => {
      await transaction.insert(tenants).values({
        id: tenantId,
        name: user.name || "Meu negócio",
        slug: `personal-${user.id}`,
        kind: "personal",
      });
      await transaction.insert(tenantMemberships).values({
        tenantId,
        userId: user.id,
        role: "owner",
      });
      await transaction.insert(profiles).values({
        id: user.id,
        tenantId,
        userId: user.id,
        email: user.email,
        displayName: user.name,
      });
    },
  );
  return tenantId;
}
