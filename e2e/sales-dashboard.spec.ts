import { randomUUID } from "node:crypto";
import { Client } from "pg";
import { expect, request, test as base, type BrowserContext, type Page } from "@playwright/test";
import { hashPassword } from "../src/server/auth/password.server";

const baseURL = process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173";

interface SalesTenant {
  userId: string;
  tenantId: string;
  productId: string;
  email: string;
  password: string;
  productName: string;
}

const QUANTIDADE = "2";
const PRECO_UNITARIO = "25";
// Quantidade × preço unitário: 2 × R$ 25,00 = R$ 50,00 (líquido = bruto quando não informado).
const VALOR_VENDA = /R\$\s?50,00/;

function adminUrl(): string {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error("DATABASE_ADMIN_URL deve estar configurada para o seed E2E de vendas");
  return url;
}

// SQL deliberado: mesmo padrão de scripts/e2e/seed-auth.ts — fixture isolada por
// test (tenant próprio) via DATABASE_ADMIN_URL; nenhum input externo nas listas
// de tabelas e todos os valores são parametrizados.
// pi-lens-ignore: no-sql-in-code
async function seedTenant(projectName: string): Promise<SalesTenant> {
  const userId = randomUUID();
  const tenantId = randomUUID();
  const productId = randomUUID();
  const password = randomUUID();
  const email = `e2e-sales-${projectName.toLowerCase()}-${userId.slice(0, 8)}@example.test`;
  const productName = "Produto E2e Vendas";

  const client = new Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    await client.query("begin");
    await client.query(
      `insert into users (id, name, email, email_verified) values ($1, 'E2e Vendas', $2, true)`,
      [userId, email],
    );
    await client.query(
      `insert into accounts (id, account_id, provider_id, user_id, password, issuer)
       values ($1, $2, 'credential', $2, $3, 'local:credential')`,
      [`e2e-sales-credential-${userId}`, userId, await hashPassword(password)],
    );
    await client.query(
      `insert into tenants (id, name, slug, kind) values ($1, 'Tenant E2e Vendas', $2, 'personal')`,
      [tenantId, `e2e-sales-${tenantId.slice(0, 8)}`],
    );
    await client.query(
      `insert into tenant_memberships (tenant_id, user_id, role) values ($1, $2, 'owner')`,
      [tenantId, userId],
    );
    await client.query(
      `insert into profiles (id, tenant_id, user_id, email, display_name)
       values ($1, $2, $1, $3, 'E2e Vendas')`,
      [userId, tenantId, email],
    );
    await client.query(
      `insert into products (id, tenant_id, user_id, name, current_price, yield_qty, yield_unit, tax_rate)
       values ($1, $2, $3, $4, '20.0000', '10.000000', 'unidade', '0.100000')`,
      [productId, tenantId, userId, productName],
    );
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }

  return { userId, tenantId, productId, email, password, productName };
}

async function purgeTenant(tenant: SalesTenant): Promise<void> {
  const client = new Client({ connectionString: adminUrl() });
  await client.connect();
  try {
    await client.query("begin");
    for (const table of [
      "ai_daily_budgets",
      "ai_usage",
      "audit_events",
      "calculation_snapshots",
      "chat_messages",
      "chat_conversations",
      "expenses",
      "idempotency_records",
      "market_prices",
      "product_ingredients",
      "product_packaging",
      "purchase_price_history",
      "sales_fees",
      "simulations",
      "tool_executions",
      "profiles",
      // sales_items cai por CASCADE de sales; products só depois de tudo que referencia produto.
      "sales",
      "products",
    ]) {
      // pi-lens-ignore: no-sql-in-code
      await client.query(`delete from ${table} where tenant_id = $1`, [tenant.tenantId]);
    }
    await client.query("delete from tenant_memberships where tenant_id = $1", [tenant.tenantId]);
    await client.query("delete from tenants where id = $1", [tenant.tenantId]);
    await client.query("delete from users where id = $1", [tenant.userId]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    await client.end();
  }
}

interface SalesSession {
  tenant: SalesTenant;
  cookies: Parameters<BrowserContext["addCookies"]>[0][number][];
}

// O rate-limit do Better Auth (/sign-in/email: 5/min por IP+path) é a única
// razão para escolher IPs aleatórios do bloco TEST-NET-2 reservado a testes:
// cada login isolado ganha um bucket próprio, sem competir com os buckets por
// project da suíte ui-stack (198.51.100.10-.14) nem com re-execuções locais.
function signInBucketIp(): string {
  return `198.51.100.${1 + Math.floor(Math.random() * 250)}`;
}

const test = base.extend<{ salesSession: SalesSession }>({
  // Tenant isolado por test: a suíte ui-stack exige "Nenhuma venda real
  // registrada." no tenant demo, então vendas E2E nunca podem tocar nele.
  // Por test (não por worker) porque o Playwright reutiliza workers entre
  // projects sob fullyParallel, o que compartilharia vendas entre cenários.
  salesSession: async ({ browser }, proceed, testInfo) => {
    const tenant = await seedTenant(testInfo.project.name);
    try {
      const api = await request.newContext({
        baseURL,
        extraHTTPHeaders: {
          origin: baseURL,
          "sec-fetch-site": "same-origin",
          "x-forwarded-for": signInBucketIp(),
        },
      });
      try {
        const response = await api.post("/api/auth/sign-in/email", {
          data: { email: tenant.email, password: tenant.password },
        });
        expect(response.ok(), await response.text()).toBe(true);
        await proceed({ tenant, cookies: (await api.storageState()).cookies });
      } finally {
        await api.dispose();
      }
    } finally {
      await purgeTenant(tenant);
    }
  },
});

// Substitui a sessão do tenant demo (storageState global) pela sessão do
// tenant isolado deste arquivo, preservando contexto/emulação de mídia
// padrão do Playwright.
test.beforeEach(async ({ context, salesSession }) => {
  await context.clearCookies();
  await context.addCookies(salesSession.cookies);
});

function metricCard(page: Page, label: string) {
  // O rótulo é renderizado como nó próprio. `hasText` (substring, case-insensitive)
  // casaria também cards cujo *explain* menciona o mesmo termo — ex.: o card de
  // margem consolidada explica "quantas unidades de cada produto foram vendidas",
  // e o filtro por "Produtos" resolvia 2 elementos (strict mode violation).
  // Ancorar no texto exato mantém a asserção e remove a ambiguidade.
  return page.locator("div.grid.gap-4 > div.bg-card").filter({
    has: page.getByText(label, { exact: true }),
  });
}

async function registerSaleViaForm(page: Page, tenant: SalesTenant): Promise<void> {
  await page.goto("/vendas");
  await expect(page.getByRole("heading", { name: "Vendas", exact: true })).toBeVisible();

  await page.getByLabel("Produto", { exact: true }).click();
  await page.getByRole("option", { name: tenant.productName, exact: true }).click();
  await page.getByLabel("Data da venda").fill(new Date().toISOString().slice(0, 10));
  await page.getByLabel("Quantidade").fill(QUANTIDADE);
  await page.getByLabel("Preço unitário (R$)").fill(PRECO_UNITARIO);
  await page.getByRole("button", { name: "Registrar venda" }).click();

  await expect(page.getByText("Venda registrada", { exact: true })).toBeVisible();
}

test("dashboard isolado mostra faturamento vazio explícito (INV-006) e margem com DADOS INCOMPLETOS", async ({
  page,
  salesSession: { tenant },
}) => {
  await page.goto("/inicio");
  await expect(page.getByRole("heading", { name: "Olá! 👋" })).toBeVisible();

  const revenue = metricCard(page, "Faturamento real");
  await expect(revenue).toContainText("—");
  await expect(revenue).toContainText("Nenhuma venda real registrada.");

  const margin = metricCard(page, "Margem consolidada");
  await expect(margin).toContainText("—");
  await expect(margin.getByText("DADOS INCOMPLETOS", { exact: true })).toBeVisible();
  await expect(margin).toContainText("Registre vendas reais para calcular o mix real de vendas.");

  await expect(metricCard(page, "Produtos")).toContainText("1");
});

test("registrar venda pelo formulário aparece em Vendas recentes", async ({
  page,
  salesSession: { tenant },
}) => {
  await registerSaleViaForm(page, tenant);

  const recent = page.locator("div.bg-card", {
    has: page.getByText("Vendas recentes"),
  });
  await expect(recent.getByText(/registrada\(s\)/i)).toBeVisible();
  await expect(recent.getByText(tenant.productName)).toContainText(VALOR_VENDA);
});

test("venda registrada aparece no faturamento real nos períodos Mês e Ano", async ({
  page,
  salesSession: { tenant },
}) => {
  await registerSaleViaForm(page, tenant);

  await page.goto("/inicio");
  const periodGroup = page.getByRole("group", { name: "Período do faturamento" });
  await expect(periodGroup.getByRole("button", { name: "Mês", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );

  const revenue = metricCard(page, "Faturamento real");
  await expect(revenue).toContainText(VALOR_VENDA);
  await expect(revenue).toContainText("1 venda(s) no período selecionado.");
  await expect(metricCard(page, "Produtos")).toContainText("1");

  await periodGroup.getByRole("button", { name: "Ano", exact: true }).click();
  await expect(periodGroup.getByRole("button", { name: "Ano", exact: true })).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await expect(revenue).toContainText(VALOR_VENDA);
  await expect(revenue).toContainText("1 venda(s) no período selecionado.");
});
