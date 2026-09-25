import AxeBuilder from "@axe-core/playwright";
import { expect, test, type Page } from "@playwright/test";

const authEmail = process.env.E2E_AUTH_EMAIL ?? "";
const authPassword = process.env.E2E_AUTH_PASSWORD ?? "";

function memberEmail(): string {
  if (process.env.E2E_AUTH_MEMBER_EMAIL) return process.env.E2E_AUTH_MEMBER_EMAIL;
  const [localPart, domain] = authEmail.split("@");
  if (!localPart || !domain) return "";
  return `${localPart}+member@${domain}`;
}

const memberPassword = process.env.E2E_AUTH_MEMBER_PASSWORD ?? authPassword;

async function expectNoBlockingAxeViolations(page: Page) {
  const results = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"])
    .analyze();
  const blocking = results.violations.filter(
    (violation) => violation.impact === "critical" || violation.impact === "serious",
  );

  expect(blocking).toEqual([]);
}

async function signInWithBetterAuth(page: Page, email: string, password: string): Promise<void> {
  const pageUrl = page.url();
  const origin = pageUrl.startsWith("http")
    ? new URL(pageUrl).origin
    : (process.env.PLAYWRIGHT_BASE_URL ?? "http://127.0.0.1:4173");
  const response = await page.request.post("/api/auth/sign-in/email", {
    headers: { origin, "sec-fetch-site": "same-origin" },
    data: { email, password },
  });
  expect(response.ok(), await response.text()).toBe(true);
}

async function login(page: Page): Promise<void> {
  expect(authEmail, "E2E_AUTH_EMAIL deve estar configurada").not.toBe("");
  expect(authPassword, "E2E_AUTH_PASSWORD deve estar configurada").not.toBe("");
  await page.goto("/auth");
  await page.getByLabel("E-mail").fill(authEmail);
  await page.getByLabel("Senha").fill(authPassword);
  await page.getByRole("button", { name: "Entrar", exact: true }).click();
  await expect(page).toHaveURL(/\/inicio$/);
}

test("public UI uses valid composed controls and has no serious a11y violations", async ({
  page,
}) => {
  await page.context().clearCookies();
  const response = await page.goto("/");

  await expect(page.getByRole("heading", { name: /entenda a faixa de preço/i })).toBeVisible();
  await expect(page.locator("a button, button a")).toHaveCount(0);
  expect(response).not.toBeNull();
  const reportOnlyCsp = response?.headers()["content-security-policy-report-only"] ?? "";
  expect(reportOnlyCsp).toContain("script-src 'self'");
  expect(reportOnlyCsp).toContain("report-uri /api/csp-report");
  expect(reportOnlyCsp).toContain("report-to csp-endpoint");
  expect(response?.headers()["reporting-endpoints"]).toBe('csp-endpoint="/api/csp-report"');
  // Sem CSP_ENFORCE o header de enforcement não existe — é o switch de rollback por env.
  expect(response?.headers()["content-security-policy"]).toBeUndefined();
  expect(response?.headers()["x-content-type-options"]).toBe("nosniff");

  const startLink = page.getByRole("link", { name: /começar agora/i });
  await startLink.focus();
  await expect(startLink).toBeFocused();

  await expectNoBlockingAxeViolations(page);
});

// O canal apontado por `report-uri` precisa existir de fato: apontar para uma rota
// inexistente tornaria a coleta (e o gate de zero violações) silenciosamente vazia.
test("the CSP report channel answers 204 for a violation report", async ({ request }) => {
  const report = await request.post("/api/csp-report", {
    headers: { "content-type": "application/csp-report" },
    data: JSON.stringify({
      "csp-report": {
        "document-uri": "https://preview.invalid/inicio",
        "effective-directive": "script-src",
        "blocked-uri": "https://cdn.example/blocked.js",
      },
    }),
  });

  expect(report.status()).toBe(204);
  expect(report.headers()["cache-control"]).toBe("no-store");
});

test("authentication controls keep accessible names", async ({ page, browserName }) => {
  await page.context().clearCookies();
  await page.goto("/inicio");
  await expect(page).toHaveURL(/\/auth(?:\?|$)/);

  const googleButton = page.getByRole("button", { name: "Continuar com Google" });
  const email = page.getByLabel("E-mail");
  const password = page.getByLabel("Senha");
  const submit = page.getByRole("button", { name: "Entrar", exact: true });

  await expect(email).toBeVisible();
  await expect(password).toBeVisible();
  await expect(submit).toBeVisible();
  await expect(page.locator("button button, a button, button a")).toHaveCount(0);

  await googleButton.focus();
  await expect(googleButton).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(email).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(password).toBeFocused();
  await page.keyboard.press("Tab");
  await expect(submit).toBeFocused();

  if (browserName === "chromium") await login(page);
});

test("authentication matrix rejects invalid Better Auth credentials and protects routes", async ({
  page,
}) => {
  await page.context().clearCookies();
  await page.goto("/auth");

  const response = await page.request.post("/api/auth/sign-in/email", {
    headers: {
      origin: new URL(page.url()).origin,
      "sec-fetch-site": "same-origin",
    },
    data: { email: authEmail, password: `${authPassword}-invalid` },
  });
  expect(response.status()).toBe(401);

  await page.goto("/inicio");
  await expect(page).toHaveURL(/\/auth\?redirect=%2Finicio/);
});

test("authorization matrix blocks member mutations with a Better Auth session", async ({
  page,
}) => {
  expect(memberEmail(), "E2E_AUTH_MEMBER_EMAIL derivável é obrigatória").not.toBe("");
  expect(memberPassword, "E2E_AUTH_MEMBER_PASSWORD derivável é obrigatória").not.toBe("");
  await page.context().clearCookies();
  await page.goto("/auth");
  await signInWithBetterAuth(page, memberEmail(), memberPassword);
  await page.goto("/despesas");
  await expect(page.getByRole("heading", { name: "Minhas Despesas" })).toBeVisible();

  await page.getByLabel("Nome").fill("Tentativa de mutação não autorizada");
  await page.getByLabel("Valor (R$)").fill("1");
  const responsePromise = page.waitForResponse(
    (response) => response.url().includes("/_serverFn/") && response.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Adicionar despesa" }).click();
  const response = await responsePromise;
  expect(response.status()).toBe(403);
});

test("CSRF rejects a cross-site replay of a server-function mutation", async ({ page }) => {
  expect(memberEmail(), "E2E_AUTH_MEMBER_EMAIL derivável é obrigatória").not.toBe("");
  expect(memberPassword, "E2E_AUTH_MEMBER_PASSWORD derivável é obrigatória").not.toBe("");
  await page.context().clearCookies();
  await page.goto("/auth");
  await signInWithBetterAuth(page, memberEmail(), memberPassword);
  await page.goto("/despesas");

  await page.getByLabel("Nome").fill("Replay CSRF de teste");
  await page.getByLabel("Valor (R$)").fill("1");
  const requestPromise = page.waitForRequest(
    (request) => request.url().includes("/_serverFn/") && request.method() === "POST",
  );
  await page.getByRole("button", { name: "Adicionar despesa" }).click();
  const originalRequest = await requestPromise;

  const replay = await page.request.fetch(originalRequest.url(), {
    method: "POST",
    headers: {
      ...originalRequest.headers(),
      origin: "https://evil.example",
      "sec-fetch-site": "cross-site",
    },
    data: originalRequest.postData() ?? undefined,
  });

  expect(replay.status()).toBe(403);
});

test("authenticated shell uses an HttpOnly session and accessible navigation", async ({ page }) => {
  await page.goto("/");

  await expect(page).toHaveURL(/\/inicio$/);
  await expect(page.getByRole("heading", { name: "Olá! 👋" })).toBeVisible();
  await expect(page.getByText("Faturamento real", { exact: true })).toBeVisible();
  await expect(page.getByText("Nenhuma venda real registrada.", { exact: true })).toBeVisible();
  await expect(page.getByText("Faturamento p/ equilíbrio", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Margem média", { exact: true })).toHaveCount(0);

  const mobileMenu = page.getByRole("button", { name: "Abrir menu de navegação" });
  if (await mobileMenu.isVisible()) await mobileMenu.click();

  const productsLink = page.getByRole("link", { name: "Meus Produtos" }).filter({ visible: true });
  await expect(productsLink).toBeVisible();
  await productsLink.focus();
  await expect(productsLink).toBeFocused();
  await expect(page.locator("button button, a button, button a")).toHaveCount(0);

  if (await mobileMenu.isVisible()) await page.keyboard.press("Escape");
  await expectNoBlockingAxeViolations(page);

  const serverFnRequestPromise = page.waitForRequest(
    (request) => request.headers()["x-tsr-serverfn"] === "true",
  );
  await page.goto("/novo-produto");
  const serverFnRequest = await serverFnRequestPromise;
  expect(serverFnRequest.headers().authorization).toBeUndefined();

  await expect(
    page.getByText("Mensagem restaurada do histórico E2E.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Ver produto" })).toBeVisible();
  await page.reload();
  await expect(
    page.getByText("Mensagem restaurada do histórico E2E.", { exact: true }),
  ).toBeVisible();
  await expect(page.getByRole("button", { name: "Ver produto" })).toBeVisible();

  const cookies = await page.context().cookies();
  const sessionCookie = cookies.find((cookie) => cookie.name.includes("session_token"));
  expect(sessionCookie?.httpOnly).toBe(true);
  expect(sessionCookie?.sameSite).toBe("Lax");
  expect(await page.evaluate(() => document.cookie)).not.toContain("session_token");
  const storageKeys = await page.evaluate(() => [
    ...Object.keys(window.localStorage),
    ...Object.keys(window.sessionStorage),
  ]);
  expect(storageKeys.filter((key) => /token|session|auth/i.test(key))).toEqual([]);
});

test("manual simulation has no fictitious current volume and labels hypothetical results", async ({
  page,
}) => {
  await page.goto("/simulacoes");

  await expect(page.getByRole("heading", { name: "Simulações" })).toBeVisible();
  const volume = page.getByLabel("Vendas simuladas (unidades)");
  await expect(volume).toHaveValue("");
  await expect(page.getByText(/nenhum volume padrão é presumido/i)).toBeVisible();
  await expect(page.getByText("Cenário atual", { exact: true })).toHaveCount(0);
  await expect(page.getByText("Diferença vs. atual", { exact: true })).toHaveCount(0);

  await volume.fill("100");

  await expect(page.getByText("Faturamento simulado", { exact: true })).toBeVisible();
  await expect(
    page.getByText("Resultado operacional simulado dentro do escopo informado", { exact: true }),
  ).toBeVisible();
  await expect(page.getByText("Informado manualmente", { exact: true })).toBeVisible();

  const price = page.getByLabel("Preço de venda simulado (R$)");
  await price.fill("");
  await expect(
    page.getByText("Preencha os campos indicados da simulação para calcular."),
  ).toBeVisible();
  await expect(price).toHaveAttribute("aria-describedby", "simulation-field-message");
  await price.fill("20");
  await expect(page.getByText("Faturamento simulado", { exact: true })).toBeVisible();
  await expectNoBlockingAxeViolations(page);
});

test("diagnostic forms prices only from explicit assumptions", async ({ page }) => {
  await page.goto("/diagnostico");

  await expect(page.getByRole("heading", { name: "Meu Diagnóstico" })).toBeVisible();
  const variableUnitCost = page.getByLabel("Outros custos variáveis por unidade (R$)");
  const targetRate = page.getByLabel("Margem de contribuição alvo (%)");
  await expect(variableUnitCost).toHaveValue("");
  await expect(targetRate).toHaveValue("");
  await expect(page.getByText(/valores ausentes não são tratados como zero/i)).toBeVisible();
  await expect(page.getByText(/despesas variáveis periódicas cadastradas/i)).toBeVisible();
  await expect(page.getByText(/preço sugerido/i)).toHaveCount(0);

  await variableUnitCost.fill("2");
  await targetRate.fill("20");

  const minimumCard = page
    .getByText("Preço mínimo para custos unitários", { exact: true })
    .locator("..");
  const targetCard = page.getByText("Preço para margem-alvo", { exact: true }).locator("..");
  const marketCard = page
    .getByText("Preço médio de mercado informado", { exact: true })
    .locator("..");
  await expect(minimumCard).toContainText("14,12");
  await expect(targetCard).toContainText("18,46");
  await expect(marketCard).toContainText("18,00");

  await targetRate.fill("90");
  await expect(targetRate).toHaveAttribute("aria-invalid", "true");
  await expect(page.getByRole("alert")).toContainText("Revise os custos, as taxas e a margem alvo");
  await targetRate.fill("20");
  await expectNoBlockingAxeViolations(page);
});

test("chat HTTP dispatch survives a missing framework signal (BUG-CHAT)", async ({ page }) => {
  await page.goto("/novo-produto");
  await expect(page.getByRole("heading", { name: "Cadastro conversacional" })).toBeVisible();

  const probe = `BUGCHAT-${Date.now()}`;
  const responsePromise = page.waitForResponse(
    (response) =>
      response.url().includes("/_serverFn/") &&
      response.request().method() === "POST" &&
      (response.request().postData() ?? "").includes(probe),
  );
  await page.locator("#novo-produto-mensagem").fill(probe);
  await page.getByRole("button", { name: "Enviar" }).click();
  const response = await responsePromise;
  const body = await response.text();

  expect(body).not.toContain("signals[0]");
  expect(body).not.toContain("TypeError");
  expect(response.status()).toBeLessThan(500);

  const textarea = page.locator("#novo-produto-mensagem");
  await expect(textarea).toBeEnabled({ timeout: 15_000 });
  await expect(page.getByRole("log")).toContainText(/⚠️|indisponível|resposta/i, {
    timeout: 15_000,
  });
  await textarea.fill(`BUGCHAT-followup-${Date.now()}`);
  await expect(page.getByRole("button", { name: "Enviar" })).toBeEnabled({ timeout: 15_000 });
});

test("financial query failure is not rendered as empty or zero data", async ({ page }) => {
  await page.route("**/_serverFn/**", async (route) => {
    await route.fulfill({ status: 503, contentType: "application/json", body: "{}" });
  });

  await page.goto("/simulacoes");
  await expect(page.getByRole("alert")).toContainText(
    "Não foi possível carregar os dados financeiros",
  );
  await expect(page.getByText(/cadastre um produto para criar/i)).toHaveCount(0);
  await expect(page.getByText(/^Referência de atendimento: SIM-/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Tentar novamente" })).toBeVisible();
  await expectNoBlockingAxeViolations(page);

  await page.goto("/inicio");
  await expect(page.getByRole("alert")).toContainText(
    "Não foi possível carregar o resumo financeiro",
  );
  await expect(page.getByRole("heading", { name: "Olá! 👋" })).toHaveCount(0);
  await expect(page.getByText(/^Referência de atendimento: DASH-/)).toBeVisible();
  await expect(page.getByRole("button", { name: "Tentar novamente" })).toBeVisible();
  await expectNoBlockingAxeViolations(page);

  await page.goto("/diagnostico");
  await expect(page.getByRole("alert")).toContainText(
    "Não foi possível carregar os dados do diagnóstico",
  );
  await expect(page.getByRole("button", { name: "Tentar novamente" })).toBeVisible();
  await expectNoBlockingAxeViolations(page);
});
