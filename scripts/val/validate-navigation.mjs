#!/usr/bin/env node

import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, request } from "@playwright/test";

const DEFAULT_BASE_URL = "http://localhost:3000";
const HEALTH_PATHS = ["/api/health/live", "/api/health/ready"];
const HEALTH_TIMEOUT_MS = 30_000;
const HEALTH_REQUEST_TIMEOUT_MS = 5_000;
const HEALTH_RETRY_DELAY_MS = 1_000;
const NAVIGATION_TIMEOUT_MS = 30_000;
const ASSERTION_TIMEOUT_MS = 15_000;
const SETTLE_TIMEOUT_MS = 5_000;
const SETTLE_DELAY_MS = 200;

const ROUTES = [
  { path: "/inicio", file: "inicio", heading: "Olá! 👋" },
  { path: "/produtos", file: "produtos", heading: "Meus Produtos" },
  { path: "/precos", file: "precos", heading: "Atualizar Preços de Compra" },
  { path: "/ponto-equilibrio", file: "ponto-equilibrio", heading: "Ponto de Equilíbrio" },
  { path: "/despesas", file: "despesas", heading: "Minhas Despesas" },
  { path: "/simulacoes", file: "simulacoes", heading: "Simulações" },
  { path: "/diagnostico", file: "diagnostico", heading: "Meu Diagnóstico" },
];

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const outputDirectory = join(scriptDirectory, "out");
const outputDisplayDirectory = "scripts/val/out";
const baseUrlInput = process.env.BASE_URL?.trim() || DEFAULT_BASE_URL;
const authEmail = process.env.E2E_AUTH_EMAIL?.trim() || "";
const authPassword = process.env.E2E_AUTH_PASSWORD ?? "";
const redactionValues = [authEmail, authPassword].filter(Boolean);

let activeCapture = null;

function redact(value) {
  return redactionValues.reduce(
    (result, secret) => result.split(secret).join("[redacted]"),
    String(value),
  );
}

function errorText(error) {
  if (error instanceof Error) return redact(`${error.name}: ${error.message}`);
  return redact(error);
}

function safeUrl(value) {
  if (!value) return "—";

  try {
    const url = new URL(value);
    url.username = "";
    url.password = "";
    for (const key of [...url.searchParams.keys()]) {
      if (/(?:auth|code|key|pass|secret|state|token)/i.test(key)) {
        url.searchParams.set(key, "[redacted]");
      }
    }
    return redact(url.toString());
  } catch {
    return redact(value);
  }
}

function pathnameOf(value) {
  try {
    return new URL(value).pathname;
  } catch {
    return "";
  }
}

function routeMatches(actualPath, expectedPath) {
  return actualPath === expectedPath || actualPath === `${expectedPath}/`;
}

function successfulHttpStatus(status) {
  return Number.isInteger(status) && status >= 200 && status < 400;
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function createCapture(label) {
  return {
    label,
    finalUrl: "—",
    mainStatus: null,
    consoleErrors: [],
    pageErrors: [],
    httpErrors: [],
    requestFailures: [],
    failures: [],
    markerVisible: false,
    screenshotOk: false,
    screenshotFile: null,
    ok: false,
  };
}

function addHttpError(capture, item) {
  const duplicate = capture.httpErrors.some(
    (existing) =>
      existing.status === item.status &&
      existing.method === item.method &&
      existing.url === item.url,
  );
  if (!duplicate) capture.httpErrors.push(item);
}

function observePage(page) {
  page.on("console", (message) => {
    if (message.type() !== "error" || !activeCapture) return;
    const location = message.location().url;
    const prefix = location ? `${safeUrl(location)} — ` : "";
    activeCapture.consoleErrors.push(`${prefix}${redact(message.text())}`);
  });

  page.on("pageerror", (error) => {
    if (!activeCapture) return;
    activeCapture.pageErrors.push(errorText(error));
  });

  page.on("response", (response) => {
    if (!activeCapture || response.status() < 400) return;
    addHttpError(activeCapture, {
      status: response.status(),
      method: response.request().method(),
      url: safeUrl(response.url()),
    });
  });

  page.on("requestfailed", (failedRequest) => {
    if (!activeCapture) return;
    const failure = failedRequest.failure();
    activeCapture.requestFailures.push({
      method: failedRequest.method(),
      url: safeUrl(failedRequest.url()),
      reason: redact(failure?.errorText || "motivo desconhecido"),
    });
  });
}

async function waitForHealth(apiContext, path) {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  let attempts = 0;
  let lastStatus = null;
  let lastError = null;

  while (Date.now() < deadline) {
    attempts += 1;
    try {
      const response = await apiContext.get(path, {
        timeout: HEALTH_REQUEST_TIMEOUT_MS,
      });
      lastStatus = response.status();
      lastError = null;
      if (lastStatus === 200) {
        return { path, status: lastStatus, attempts, ok: true, detail: "HTTP 200" };
      }
    } catch (error) {
      lastStatus = null;
      lastError = errorText(error);
    }

    const remaining = deadline - Date.now();
    if (remaining > 0) await delay(Math.min(HEALTH_RETRY_DELAY_MS, remaining));
  }

  return {
    path,
    status: lastStatus,
    attempts,
    ok: false,
    detail: lastError ? `inacessível: ${lastError}` : `último status: HTTP ${lastStatus}`,
  };
}

async function runHealthChecks(baseUrl) {
  const apiContext = await request.newContext({ baseURL: baseUrl });
  try {
    return await Promise.all(HEALTH_PATHS.map((path) => waitForHealth(apiContext, path)));
  } finally {
    await apiContext.dispose();
  }
}

async function settlePage(page) {
  try {
    await page.waitForLoadState("networkidle", { timeout: SETTLE_TIMEOUT_MS });
  } catch {
    // Algumas telas mantêm requisições abertas; os listeners já registraram falhas.
  }
  try {
    await page.waitForTimeout(SETTLE_DELAY_MS);
  } catch {
    // A página pode ter sido encerrada após uma falha de navegação.
  }
}

function captureIsClean(capture) {
  return (
    capture.failures.length === 0 &&
    successfulHttpStatus(capture.mainStatus) &&
    capture.markerVisible &&
    capture.consoleErrors.length === 0 &&
    capture.pageErrors.length === 0 &&
    capture.httpErrors.length === 0 &&
    capture.requestFailures.length === 0 &&
    capture.screenshotOk
  );
}

async function loginWithUi(page) {
  const capture = createCapture("login");
  activeCapture = capture;

  try {
    const response = await page.goto("/auth", {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    capture.mainStatus = response?.status() ?? null;
    if (!response) capture.failures.push("/auth não devolveu uma resposta principal.");
    else if (!successfulHttpStatus(capture.mainStatus)) {
      capture.failures.push(`resposta principal de /auth: HTTP ${capture.mainStatus}`);
    }

    await page.getByLabel("E-mail").waitFor({
      state: "visible",
      timeout: ASSERTION_TIMEOUT_MS,
    });
    await page.getByLabel("E-mail").fill(authEmail);
    await page.getByLabel("Senha").fill(authPassword);

    await Promise.all([
      page.waitForURL((url) => routeMatches(url.pathname, "/inicio"), {
        timeout: NAVIGATION_TIMEOUT_MS,
      }),
      page.getByRole("button", { name: "Entrar", exact: true }).click(),
    ]);

    await page.getByRole("heading", { name: "Olá! 👋", exact: true }).waitFor({
      state: "visible",
      timeout: ASSERTION_TIMEOUT_MS,
    });
    await page.getByRole("link", { name: "Meus Produtos", exact: true }).waitFor({
      state: "visible",
      timeout: ASSERTION_TIMEOUT_MS,
    });
    capture.markerVisible = true;
  } catch (error) {
    capture.failures.push(`login pela UI: ${errorText(error)}`);
  }

  await settlePage(page);
  capture.finalUrl = safeUrl(page.url());
  if (!routeMatches(pathnameOf(page.url()), "/inicio")) {
    capture.failures.push(`URL final inesperada: ${capture.finalUrl}`);
  }
  capture.ok = captureIsClean(capture);
  activeCapture = null;
  return capture;
}

async function validateRoute(page, route, createdFiles) {
  const capture = createCapture(route.path);
  activeCapture = capture;

  try {
    const response = await page.goto(route.path, {
      waitUntil: "domcontentloaded",
      timeout: NAVIGATION_TIMEOUT_MS,
    });
    capture.mainStatus = response?.status() ?? null;
    if (!response) capture.failures.push("não devolveu uma resposta principal.");
    else if (!successfulHttpStatus(capture.mainStatus)) {
      capture.failures.push(`resposta principal: HTTP ${capture.mainStatus}`);
    }

    const finalPath = pathnameOf(page.url());
    if (!routeMatches(finalPath, route.path)) {
      capture.failures.push(`URL final inesperada: ${safeUrl(page.url())}`);
    } else {
      await page.getByRole("heading", { name: route.heading, exact: true }).waitFor({
        state: "visible",
        timeout: ASSERTION_TIMEOUT_MS,
      });
      capture.markerVisible = true;
    }
  } catch (error) {
    capture.failures.push(`navegação: ${errorText(error)}`);
  }

  await settlePage(page);
  capture.finalUrl = safeUrl(page.url());

  const screenshotFile = join(outputDirectory, `${route.file}.png`);
  try {
    const emailLocator = page.getByText(authEmail, { exact: true });
    const masks = (await emailLocator.count()) > 0 ? [emailLocator] : [];
    await page.screenshot({
      path: screenshotFile,
      fullPage: true,
      mask: masks,
      maskColor: "#000000",
    });
    capture.screenshotOk = true;
    capture.screenshotFile = `${outputDisplayDirectory}/${route.file}.png`;
    createdFiles.push(capture.screenshotFile);
  } catch (error) {
    capture.failures.push(`screenshot: ${errorText(error)}`);
  }

  capture.ok = captureIsClean(capture);
  activeCapture = null;
  return capture;
}

function printHealthSummary(healthResults) {
  console.log("\nHealth checks:");
  console.table(
    healthResults.map((result) => ({
      endpoint: result.path,
      status: result.status ?? "—",
      tentativas: result.attempts,
      resultado: result.ok ? "OK" : "FALHA",
      detalhe: result.detail,
    })),
  );
}

function printLoginSummary(loginResult) {
  console.log("\nLogin pela UI:");
  console.table([
    {
      fluxo: "/auth → /inicio",
      urlFinal: loginResult.finalUrl,
      principal: loginResult.mainStatus ?? "—",
      "console.error": loginResult.consoleErrors.length,
      pageerror: loginResult.pageErrors.length,
      "HTTP >=400": loginResult.httpErrors.length,
      resultado: loginResult.ok ? "OK" : "FALHA",
    },
  ]);
  printCaptureDetails(loginResult);
}

function printNavigationSummary(routeResults) {
  console.log("\nTabela-resumo da navegação:");
  console.table(
    routeResults.map((result) => ({
      rota: result.label,
      urlFinal: result.finalUrl,
      principal: result.mainStatus ?? "—",
      "console.error": result.consoleErrors.length,
      pageerror: result.pageErrors.length,
      "HTTP >=400": result.httpErrors.length,
      rede: result.requestFailures.length,
      screenshot: result.screenshotOk ? "OK" : "FALHA",
      resultado: result.ok ? "OK" : "FALHA",
    })),
  );
  for (const result of routeResults) printCaptureDetails(result);
}

function printCaptureDetails(capture) {
  const hasDetails =
    capture.failures.length > 0 ||
    capture.consoleErrors.length > 0 ||
    capture.pageErrors.length > 0 ||
    capture.httpErrors.length > 0 ||
    capture.requestFailures.length > 0;
  if (!hasDetails) return;

  console.log(`\nDetalhes de ${capture.label}:`);
  for (const failure of capture.failures) console.log(`- falha: ${failure}`);
  for (const error of capture.consoleErrors) console.log(`- console.error: ${error}`);
  for (const error of capture.pageErrors) console.log(`- pageerror: ${error}`);
  for (const error of capture.httpErrors) {
    console.log(`- HTTP >=400: ${error.method} ${error.url} → ${error.status}`);
  }
  for (const failure of capture.requestFailures) {
    console.log(`- requisição falhou: ${failure.method} ${failure.url} — ${failure.reason}`);
  }
}

function printFooter(createdFiles) {
  console.log("\nArquivos criados nesta execução:");
  if (createdFiles.length === 0) console.log("- nenhum screenshot foi criado");
  else for (const file of createdFiles) console.log(`- ${file}`);

  console.log(
    "\nVerificações: health live/ready em HTTP 200; login pela UI; shell autenticado; URL e resposta principal de cada rota; console.error; pageerror; respostas HTTP >=400; falhas de requisição; e screenshot protegido por máscara do e-mail autenticado.",
  );
  console.log(
    "Regra de escopo: nenhuma mensagem de chat/IA é submetida e nenhuma mutação de dados é iniciada.",
  );
}

function missingCredentialNames() {
  return [!authEmail ? "E2E_AUTH_EMAIL" : null, !authPassword ? "E2E_AUTH_PASSWORD" : null].filter(
    Boolean,
  );
}

function validatedBaseUrl() {
  try {
    return new URL(baseUrlInput).toString();
  } catch (error) {
    console.error(`BASE_URL inválida: ${errorText(error)}`);
    return null;
  }
}

function unavailableHealthResults(error) {
  return HEALTH_PATHS.map((path) => ({
    path,
    status: null,
    attempts: 0,
    ok: false,
    detail: `falha ao sondar: ${errorText(error)}`,
  }));
}

async function runHealthValidation(baseUrl) {
  let healthResults;
  try {
    healthResults = await runHealthChecks(baseUrl);
  } catch (error) {
    healthResults = unavailableHealthResults(error);
  }
  printHealthSummary(healthResults);
  if (healthResults.every((result) => result.ok)) return true;
  console.error("Health indisponível: ambos os endpoints precisam responder HTTP 200.");
  return false;
}

async function closePlaywrightResource(resource, label) {
  try {
    await resource.close();
    return true;
  } catch (error) {
    console.error(`Falha ao fechar ${label}: ${errorText(error)}`);
    return false;
  }
}

async function runProtectedRoutes(page, createdFiles) {
  const routeResults = [];
  for (const route of ROUTES) {
    routeResults.push(await validateRoute(page, route, createdFiles));
  }
  printNavigationSummary(routeResults);
  return routeResults.every((result) => result.ok) ? 0 : 1;
}

async function runBrowserValidation(baseUrl, createdFiles) {
  let exitCode = 1;
  let browser = null;
  let browserContext = null;
  try {
    browser = await chromium.launch({ headless: true });
    browserContext = await browser.newContext({ baseURL: baseUrl });
    const page = await browserContext.newPage();
    page.setDefaultTimeout(ASSERTION_TIMEOUT_MS);
    page.setDefaultNavigationTimeout(NAVIGATION_TIMEOUT_MS);
    observePage(page);

    const loginResult = await loginWithUi(page);
    printLoginSummary(loginResult);
    if (!loginResult.ok) {
      console.error("Login pela UI não ficou verde; as rotas protegidas não serão navegadas.");
    } else {
      exitCode = await runProtectedRoutes(page, createdFiles);
    }
  } catch (error) {
    console.error(`Falha ao executar a validação navegacional: ${errorText(error)}`);
    exitCode = 1;
  } finally {
    if (browserContext) {
      const closed = await closePlaywrightResource(browserContext, "o contexto Playwright");
      if (!closed && exitCode === 0) exitCode = 1;
    }
    if (browser) {
      const closed = await closePlaywrightResource(browser, "o navegador Playwright");
      if (!closed && exitCode === 0) exitCode = 1;
    }
  }
  return exitCode;
}

async function runValidation(createdFiles) {
  const missingCredentials = missingCredentialNames();
  if (missingCredentials.length > 0) {
    console.error(
      `Credenciais ausentes: defina ${missingCredentials.join(" e ")} no ambiente. Nenhuma credencial é lida de arquivo.`,
    );
    return 2;
  }

  const baseUrl = validatedBaseUrl();
  if (!baseUrl) return 3;
  await mkdir(outputDirectory, { recursive: true });
  if (!(await runHealthValidation(baseUrl))) return 3;
  return runBrowserValidation(baseUrl, createdFiles);
}

async function main() {
  const createdFiles = [];
  let exitCode = 1;
  try {
    exitCode = await runValidation(createdFiles);
  } catch (error) {
    console.error(`Falha ao executar a validação navegacional: ${errorText(error)}`);
    exitCode = 1;
  } finally {
    printFooter(createdFiles);
  }
  return exitCode;
}

const exitCode = await main();
process.exitCode = exitCode;
