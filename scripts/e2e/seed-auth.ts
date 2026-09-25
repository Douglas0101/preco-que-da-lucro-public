import { Client } from "pg";
import { hashPassword } from "../../src/server/auth/password.server";
import { requireAdminUrl, runMigrations } from "../db/migrate";
import { TENANT_SCOPED_TABLES } from "../db/purge-fixtures";

const userId = "00000000-0000-4000-8000-000000000001";
const memberUserId = "00000000-0000-4000-8000-000000000003";
const tenantId = "00000000-0000-4000-8000-000000000002";
const productId = "00000000-0000-4000-8000-000000000010";
const conversationId = "00000000-0000-4000-8000-000000000020";
const messageId = "00000000-0000-4000-8000-000000000021";

function required(name: "E2E_AUTH_EMAIL" | "E2E_AUTH_PASSWORD"): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} é obrigatória para preparar o E2E`);
  return value;
}

function memberEmailFor(ownerEmail: string): string {
  const [localPart, domain] = ownerEmail.split("@");
  if (!localPart || !domain) throw new Error("E2E_AUTH_EMAIL deve conter uma origem válida");
  return process.env.E2E_AUTH_MEMBER_EMAIL?.trim().toLowerCase() ?? `${localPart}+member@${domain}`;
}

async function main(): Promise<void> {
  const adminUrl = requireAdminUrl();
  const email = required("E2E_AUTH_EMAIL").trim().toLowerCase();
  const password = required("E2E_AUTH_PASSWORD");
  const memberEmail = memberEmailFor(email);
  const memberPassword = process.env.E2E_AUTH_MEMBER_PASSWORD ?? password;
  if (password.length < 10) throw new Error("E2E_AUTH_PASSWORD deve ter pelo menos 10 caracteres");

  await runMigrations(adminUrl);
  const client = new Client({ connectionString: adminUrl });
  await client.connect();
  try {
    await client.query("begin");
    const runtimePassword = process.env.E2E_DB_RUNTIME_PASSWORD;
    if (runtimePassword) {
      await client.query(
        `alter role app_runtime password ${client.escapeLiteral(runtimePassword)}`,
      );
    }

    // Lista canônica (scripts/db/purge-fixtures.ts): cobre a trilha de memória
    // (`ai_memory_access_log` é RESTRICT para memberships) e outbox/backfill.
    for (const table of TENANT_SCOPED_TABLES) {
      // SQL deliberado: lista FIXA de tabelas (sem input externo) + tenant parametrizado;
      // seeder de fixture não usa ORM para limpeza multi-tabela.
      // pi-lens-ignore: no-sql-in-code
      await client.query(`delete from ${table} where tenant_id = $1`, [tenantId]);
    }
    await client.query("delete from tenant_memberships where tenant_id = $1", [tenantId]);
    // rate_limits é global (sem tenant_id) e janelas de 60s do Better Auth
    // vazariam entre execuções E2E encadeadas; limpar tudo = re-execução determinística.
    // pi-lens-ignore: no-sql-in-code
    await client.query("delete from rate_limits");
    await client.query("delete from tenants where id = $1", [tenantId]);
    await client.query("delete from users where id in ($1, $2)", [userId, memberUserId]);
    await client.query(
      `insert into users (id, name, email, email_verified)
       values ($1, 'Teste E2E', $2, true)`,
      [userId, email],
    );
    await client.query(
      `insert into accounts (id, account_id, provider_id, user_id, password, issuer)
       values ($1, $2, 'credential', $2, $3, 'local:credential')`,
      [`e2e-credential-${userId}`, userId, await hashPassword(password)],
    );
    await client.query(
      `insert into users (id, name, email, email_verified)
       values ($1, 'Membro E2E', $2, true)`,
      [memberUserId, memberEmail],
    );
    await client.query(
      `insert into accounts (id, account_id, provider_id, user_id, password, issuer)
       values ($1, $2, 'credential', $2, $3, 'local:credential')`,
      [`e2e-credential-${memberUserId}`, memberUserId, await hashPassword(memberPassword)],
    );
    await client.query(
      `insert into tenants (id, name, slug, kind)
       values ($1, 'Tenant E2E', 'tenant-e2e', 'personal')`,
      [tenantId],
    );
    await client.query(
      `insert into tenant_memberships (tenant_id, user_id, role)
       values ($1, $2, 'owner')`,
      [tenantId, userId],
    );
    await client.query(
      `insert into tenant_memberships (tenant_id, user_id, role)
       values ($1, $2, 'member')`,
      [tenantId, memberUserId],
    );
    await client.query(
      `insert into profiles (id, tenant_id, user_id, email, display_name)
       values ($1, $2, $1, $3, 'Teste E2E')`,
      [userId, tenantId, email],
    );
    await client.query(
      `insert into profiles (id, tenant_id, user_id, email, display_name)
       values ($1, $2, $1, $3, 'Membro E2E')`,
      [memberUserId, tenantId, memberEmail],
    );
    await client.query(
      `insert into products
         (id, tenant_id, user_id, name, current_price, yield_qty, yield_unit, tax_rate)
       values ($1, $2, $3, 'Produto de teste', '20.0000', '10.000000', 'unidade', '0.100000')`,
      [productId, tenantId, userId],
    );
    await client.query(
      `insert into product_packaging
         (id, product_id, tenant_id, user_id, name, package_price, units_per_package, price_updated_at)
       values
         ('00000000-0000-4000-8000-000000000011', $1, $2, $3, 'Embalagem', '100.0000', '10.000000', now())`,
      [productId, tenantId, userId],
    );
    await client.query(
      `insert into sales_fees
         (id, product_id, tenant_id, user_id, name, percentage)
       values
         ('00000000-0000-4000-8000-000000000012', $1, $2, $3, 'Taxa de venda', '0.050000')`,
      [productId, tenantId, userId],
    );
    await client.query(
      `insert into market_prices
         (id, product_id, tenant_id, user_id, avg_price)
       values
         ('00000000-0000-4000-8000-000000000013', $1, $2, $3, '18.0000')`,
      [productId, tenantId, userId],
    );
    await client.query(
      `insert into expenses
         (id, tenant_id, user_id, name, amount, type)
       values
         ('00000000-0000-4000-8000-000000000014', $1, $2, 'Despesas fixas', '600.0000', 'fixa'),
         ('00000000-0000-4000-8000-000000000015', $1, $2, 'Despesas variáveis', '200.0000', 'variavel')`,
      [tenantId, userId],
    );
    await client.query(
      `insert into chat_conversations
         (id, tenant_id, user_id, current_product_id, confirmed_state)
       values ($1, $2, $3, $4, $5::jsonb)`,
      [
        conversationId,
        tenantId,
        userId,
        productId,
        JSON.stringify({ currentProductId: productId, lastAssistantMessageId: messageId }),
      ],
    );
    await client.query(
      `insert into chat_messages (id, conversation_id, tenant_id, user_id, role, content)
       values ($1, $2, $3, $4, 'assistant', 'Mensagem restaurada do histórico E2E.')`,
      [messageId, conversationId, tenantId, userId],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }

  console.log(
    `Fixture Better Auth/PostgreSQL preparada para owner ${email} e member ${memberEmail}.`,
  );
}

await main();
