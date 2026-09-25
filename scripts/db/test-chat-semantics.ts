import assert from "node:assert/strict";
import { sql } from "drizzle-orm";
import { drizzle } from "drizzle-orm/node-postgres";
import { Pool } from "pg";
import * as schema from "../../src/db/schema";
import { getConversationForTests } from "../../src/lib/chat-execution.server";
import type { RequestContext } from "../../src/lib/request-context";
import { ensureRuntimeRoleMembership, requireAdminUrl } from "./migrate";

const userId = "77000000-0000-4000-8000-000000000001";
const tenantId = "78000000-0000-4000-8000-000000000002";
const correlationId = "79000000-0000-4000-8000-000000000003";

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: requireAdminUrl(), max: 2 });
  const database = drizzle({ client: pool, schema });
  try {
    await ensureRuntimeRoleMembership(pool);
    await pool.query(
      `insert into users (id, name, email, email_verified) values ($1, 'Chat User', 'chat-semantics@example.test', true)
       on conflict (id) do nothing`,
      [userId],
    );
    await pool.query(
      `insert into tenants (id, name, slug, kind) values ($1, 'Chat Tenant', 'chat-semantics', 'personal')
       on conflict (id) do nothing`,
      [tenantId],
    );
    await pool.query(
      `insert into tenant_memberships (tenant_id, user_id, role) values ($1, $2, 'owner')
       on conflict (tenant_id, user_id) do nothing`,
      [tenantId, userId],
    );
    await pool.query("delete from chat_conversations where tenant_id = $1", [tenantId]);

    await database.transaction(async (transaction) => {
      await transaction.execute(sql`set local role app_runtime`);
      await transaction.execute(sql`
        select
          set_config('app.current_user_id', ${userId}, true),
          set_config('app.current_tenant_id', ${tenantId}, true),
          set_config('app.current_roles', 'owner', true)
      `);
      const context: RequestContext = {
        userId,
        tenantId,
        roles: ["owner"],
        correlationId,
        signal: new AbortController().signal,
        transaction: transaction as unknown as RequestContext["transaction"],
      };

      const before = await transaction.execute(
        sql`select count(*)::integer as count from chat_conversations where tenant_id = ${tenantId}`,
      );
      const conversation = await getConversationForTests(context);
      const after = await transaction.execute(
        sql`select count(*)::integer as count from chat_conversations where tenant_id = ${tenantId}`,
      );
      assert.equal(conversation, undefined);
      assert.equal(Number(before.rows[0]?.count), 0);
      assert.equal(Number(after.rows[0]?.count), 0, "GET history não pode criar conversa");
    });
  } finally {
    await pool.end();
  }

  console.log("Chat GET é somente leitura; criação fica restrita a POST: OK");
}

await main();
