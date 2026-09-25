#!/usr/bin/env node
/**
 * F0-04 — Captura de baseline de performance CONTROLADO (local-only).
 *
 * Sobe/reusa o preview Nitro (`npm run build` + `npm run preview`) contra o
 * PostgreSQL 17 local, dirige um circuito determinístico com Playwright
 * (dashboard, produtos, ponto de equilíbrio, simulações, diagnóstico e chat
 * com provider mockado em processo) e grava raw versionável em
 * `docs/evidence/perf-controlled-<data>/`:
 *   meta.json, route-samples.jsonl, chat-samples.jsonl, context-tx.jsonl,
 *   ai-model-attempts.jsonl, server-stdout.txt, build-output.txt,
 *   bundle-report.json.
 *
 * NUNCA aponta para produção: recusa `NODE_ENV=production`, host diferente de
 * 127.0.0.1 e DATABASE_URL/DATABASE_ADMIN_URL fora do loopback. O mock de IA
 * intercepta o fetch do gateway dentro do processo do servidor via
 * `NODE_OPTIONS=--import=<data:...>` e é sempre rotulado como CONTROLADO.
 *
 * Uso: node scripts/perf/capture-baseline.mjs [opções]
 */
import { execFileSync, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, open, readdir, readFile, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";

const DEFAULT_DATABASE_URL =
  "postgresql://postgres:postgres@127.0.0.1:5432/preco_que_da_lucro_test";
const DEFAULT_AI_MOCK_CONTENT = "Resposta mockada do baseline controlado F0-04.";
const AI_MOCK_HOST = "ai.gateway.lovable.dev";
const VITALS_SETTLE_MS = 500;

const ROUTES = [
  { path: "/inicio", ready: "heading:Olá! 👋" },
  { path: "/produtos", ready: "text:Produto de teste" },
  { path: "/ponto-equilibrio", ready: "heading:Ponto de Equilíbrio" },
  { path: "/simulacoes", ready: "text:Dados unitários do produto" },
  { path: "/diagnostico", ready: "text:Premissas da formação de preço" },
];

const HELP = `Baseline de performance CONTROLADO (F0-04) — local-only.

Uso:
  node scripts/perf/capture-baseline.mjs [opções]

Opções:
  --dir <caminho>            Diretório da evidência
                             (default: docs/evidence/perf-controlled-2026-09-13)
  --port <n>                 Porta do preview Nitro (default: 4219)
  --iterations <n>           Amostras medidas por rota (default: 5)
  --warmup <n>               Warmups descartados por rota (default: 1)
  --chat-iterations <n>      Envios de chat medidos (default: 3)
  --ai-mock-latency-ms <n>   Latência determinística do mock de IA (default: 35)
  --skip-build               Reusa .output existente (não roda npm run build)
  --skip-bundle              Não roda check:bundle (reusa cópia existente)
  --skip-db                  Não roda db:up nem e2e:prepare
  --reuse-server             Reusa preview já ouvindo em 127.0.0.1:<port>
  --no-playwright            Pula o circuito de browser (declara lacuna)
  --help                     Mostra esta ajuda

Pré-requisitos:
  - Token DB do enxame adquirido pelo operador (lock /tmp/opencode/onda0-db.lock).
  - Docker com postgres:17 local (npm run db:up é idempotente).
  - E2E_AUTH_EMAIL/E2E_AUTH_PASSWORD: default local controlado se ausentes.
  - Playwright (chromium) instalado para o circuito de browser.

Nunca usa rede externa: o provider de IA é mockado no processo do servidor.
`;

function fail(message) {
  throw new Error(message);
}

function gitHead() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: root,
      encoding: "utf8",
    }).trim();
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const options = {
    dir: path.join(root, "docs/evidence/perf-controlled-2026-09-13"),
    port: 4219,
    iterations: 5,
    warmup: 1,
    chatIterations: 3,
    aiMockLatencyMs: 35,
    skipBuild: false,
    skipBundle: false,
    skipDb: false,
    reuseServer: false,
    noPlaywright: false,
    help: false,
  };
  const valueFlags = new Map([
    ["--dir", "dir"],
    ["--port", "port"],
    ["--iterations", "iterations"],
    ["--warmup", "warmup"],
    ["--chat-iterations", "chatIterations"],
    ["--ai-mock-latency-ms", "aiMockLatencyMs"],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    if (valueFlags.has(arg)) {
      const raw = argv[index + 1];
      if (!raw) fail(`${arg} exige um valor`);
      const key = valueFlags.get(arg);
      options[key] = key === "dir" ? path.resolve(raw) : Number(raw);
      if (key !== "dir" && !Number.isFinite(options[key])) fail(`${arg} exige um número`);
      index += 1;
      continue;
    }
    if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--skip-bundle") options.skipBundle = true;
    else if (arg === "--skip-db") options.skipDb = true;
    else if (arg === "--reuse-server") options.reuseServer = true;
    else if (arg === "--no-playwright") options.noPlaywright = true;
    else fail(`Argumento desconhecido: ${arg}`);
  }
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65_535) {
    fail("--port deve ser uma porta válida");
  }
  for (const key of ["iterations", "warmup", "chatIterations"]) {
    if (!Number.isInteger(options[key]) || options[key] < 0 || options[key] > 50) {
      fail(`--${key} deve ser um inteiro entre 0 e 50`);
    }
  }
  return options;
}

function localOnlyUrl(raw, label) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(`${label} inválida: ${raw}`);
  }
  if (url.hostname !== "127.0.0.1") {
    fail(`${label} recusada: somente 127.0.0.1 (recebido "${url.hostname}")`);
  }
  return url;
}

function assertLocalEnvironment(options) {
  if (process.env.NODE_ENV === "production") {
    fail("NODE_ENV=production recusado: a captura é local-only.");
  }
  localOnlyUrl(`http://127.0.0.1:${options.port}`, "base URL");
  const databaseUrl = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  const adminUrl = process.env.DATABASE_ADMIN_URL ?? databaseUrl;
  if (!/^postgres(ql)?:\/\//.test(databaseUrl)) fail("DATABASE_URL deve ser postgres:// local");
  localOnlyUrl(databaseUrl, "DATABASE_URL");
  localOnlyUrl(adminUrl, "DATABASE_ADMIN_URL");
  return { databaseUrl, adminUrl };
}

function mockedFetchHookSource(content) {
  return `
const perfMockContent = ${JSON.stringify(content)};
const originalFetch = globalThis.fetch.bind(globalThis);
globalThis.fetch = async (input, init) => {
  const rawUrl = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
  let hostname = "";
  try {
    hostname = new URL(rawUrl).hostname;
  } catch {
    hostname = "";
  }
  if (process.env.PERF_AI_MOCK === "1" && hostname === ${JSON.stringify(AI_MOCK_HOST)}) {
    const latency = Number(process.env.PERF_AI_MOCK_LATENCY_MS ?? "35");
    await new Promise((resolve) => setTimeout(resolve, latency));
    return new Response(
      JSON.stringify({
        model: "perf/mock-model",
        choices: [{ message: { content: perfMockContent } }],
        usage: { prompt_tokens: 128, completion_tokens: 32 },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  }
  return originalFetch(input, init);
};
`;
}

function buildCommandEnv(options, databaseUrl, adminUrl) {
  const env = { ...process.env };
  env.DATABASE_URL = databaseUrl;
  env.DATABASE_ADMIN_URL = adminUrl;
  env.DATABASE_DRIVER = env.DATABASE_DRIVER ?? "node-postgres";
  env.BETTER_AUTH_URL = `http://127.0.0.1:${options.port}`;
  env.AUTH_TRUSTED_ORIGINS = `http://127.0.0.1:${options.port}`;
  env.BETTER_AUTH_SECRET = env.BETTER_AUTH_SECRET ?? randomBytes(32).toString("hex");
  env.E2E_AUTH_EMAIL = env.E2E_AUTH_EMAIL ?? "perf.controlled@example.test";
  env.E2E_AUTH_PASSWORD = env.E2E_AUTH_PASSWORD ?? "perf-controlled-password-1";
  env.AI_GATEWAY_API_KEY = env.AI_GATEWAY_API_KEY ?? "perf-mock-key";
  env.PERF_AI_MOCK = "1";
  env.PERF_AI_MOCK_LATENCY_MS = String(options.aiMockLatencyMs);
  env.PERF_AI_MOCK_CONTENT = env.PERF_AI_MOCK_CONTENT ?? DEFAULT_AI_MOCK_CONTENT;
  return env;
}

/**
 * O build atual (Vite 8/Rolldown) divide `createCsrfMiddleware` em um chunk
 * circular — `ssr.mjs` importa o chunk pequeno antes do chunk grande, e o
 * `defaultCsrfMiddleware = createCsrfMiddleware(...)` de topo roda com a
 * binding ainda indefinida. Pré-importar o chunk grande restaura a ordem de
 * avaliação correta sem alterar qualquer lógica do app. É um workaround
 * declarado, não uma correção do build.
 */
async function findSsrPreloadChunk() {
  const ssrDir = path.join(root, ".output/server/_ssr");
  let entries = [];
  try {
    entries = await readdir(ssrDir);
  } catch {
    return null;
  }
  for (const name of entries) {
    if (!/^server-.*\.mjs$/.test(name)) continue;
    const contents = await readFile(path.join(ssrDir, name), "utf8");
    if (contents.includes("defaultCsrfMiddleware = createCsrfMiddleware")) {
      return { name, fileUrl: pathToFileURL(path.join(ssrDir, name)).href };
    }
  }
  return null;
}

function buildPreviewEnv(options, commandEnv, preloadChunk) {
  const env = { ...commandEnv };
  const imports = [
    `data:text/javascript,${encodeURIComponent(mockedFetchHookSource(env.PERF_AI_MOCK_CONTENT))}`,
  ];
  if (preloadChunk) {
    const source = `await import(${JSON.stringify(preloadChunk.fileUrl)});`;
    imports.push(`data:text/javascript,${encodeURIComponent(source)}`);
  }
  env.NODE_OPTIONS = [...imports.map((url) => `--import=${url}`), env.NODE_OPTIONS]
    .filter(Boolean)
    .join(" ");
  return env;
}

function runCommand(label, args, { env, cwd = root, logPath }) {
  return new Promise((resolve, reject) => {
    const child = spawn(npmCommand, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
    const chunks = [];
    child.stdout.on("data", (chunk) => {
      chunks.push(chunk);
      process.stdout.write(`[${label}] ${chunk}`);
    });
    child.stderr.on("data", (chunk) => {
      chunks.push(chunk);
      process.stderr.write(`[${label}] ${chunk}`);
    });
    child.once("error", reject);
    child.once("close", async (code) => {
      if (logPath) await writeFile(logPath, Buffer.concat(chunks));
      resolve(code ?? 1);
    });
  });
}

async function readNewRecords(logPath, state) {
  let contents;
  try {
    contents = await readFile(logPath, "utf8");
  } catch {
    return [];
  }
  const pending = contents.slice(state.offset);
  const lastBreak = pending.lastIndexOf("\n");
  if (lastBreak < 0) return [];
  const complete = pending.slice(0, lastBreak + 1);
  state.offset += lastBreak + 1;
  const records = [];
  for (const line of complete.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    try {
      const parsed = JSON.parse(trimmed);
      if (typeof parsed.event === "string") records.push(parsed);
    } catch {
      // Linha parcial/ não-JSON (saída do Vite/nitro) — ignorada de propósito.
    }
  }
  return records;
}

async function attributeNewRecords(logPath, state, phase, iteration, warmup, sinks, log) {
  const records = await readNewRecords(logPath, state);
  for (const record of records) {
    if (record.event === "app.context_tx") {
      const entry = {
        kind: "context_tx",
        timestamp: record.timestamp,
        round_trips: record.round_trips,
        outcome: record.outcome,
        duration_ms: record.duration_ms,
        phase,
        iteration,
        warmup,
      };
      sinks.contextTx.push(entry);
      await appendFile(path.join(sinks.dir, "context-tx.jsonl"), `${JSON.stringify(entry)}\n`);
    } else if (record.event === "ai.model_attempt") {
      const entry = {
        kind: "ai.model_attempt",
        timestamp: record.timestamp,
        model: record.model,
        attempt: record.attempt,
        durationMs: record.durationMs,
        outcome: record.outcome,
        phase,
        iteration,
        warmup,
      };
      sinks.aiAttempts.push(entry);
      await appendFile(
        path.join(sinks.dir, "ai-model-attempts.jsonl"),
        `${JSON.stringify(entry)}\n`,
      );
    }
  }
  if (log) log.records += records.length;
  return records;
}

async function healthOk(port) {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/api/health/live`, {
      signal: AbortSignal.timeout(2_000),
    });
    return response.ok;
  } catch {
    return false;
  }
}

function tcpOk(host, port, timeoutMs = 1_500) {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    const finish = (ok) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
    socket.once("timeout", () => finish(false));
  });
}

async function waitForHealth(port, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await healthOk(port)) return true;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  return false;
}

async function startPreview(options, env, logPath) {
  const handle = await open(logPath, "a");
  const child = spawn(
    npmCommand,
    ["run", "preview", "--", "--host", "127.0.0.1", "--port", String(options.port)],
    {
      cwd: root,
      env,
      detached: true,
      stdio: ["ignore", handle.fd, handle.fd],
    },
  );
  await handle.close();
  child.unref();
  return child;
}

function stopPreview(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGTERM");
  } catch {
    // Processo já saiu — nada a fazer.
  }
}

function killPreview(child) {
  if (!child || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, "SIGKILL");
  } catch {
    // Processo já saiu — nada a fazer.
  }
}

async function waitForExit(child, timeoutMs) {
  if (child.exitCode !== null) return;
  await new Promise((resolve) => {
    const timer = setTimeout(() => resolve(), timeoutMs);
    child.once("close", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

function collectVitals(settleMs) {
  return new Promise((resolve) => {
    const result = {
      lcpMs: null,
      cls: null,
      fcpMs: null,
      ttfbMs: null,
      domContentLoadedMs: null,
      loadMs: null,
    };
    const nav = performance.getEntriesByType("navigation")[0];
    if (nav) {
      result.ttfbMs = nav.responseStart > 0 ? nav.responseStart - nav.startTime : null;
      result.domContentLoadedMs =
        nav.domContentLoadedEventEnd > 0 ? nav.domContentLoadedEventEnd - nav.startTime : null;
      result.loadMs = nav.loadEventEnd > 0 ? nav.loadEventEnd - nav.startTime : null;
    }
    const fcp = performance.getEntriesByName("first-contentful-paint")[0];
    if (fcp) result.fcpMs = fcp.startTime;
    let cls = 0;
    let lcp = null;
    try {
      const observer = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) if (!entry.hadRecentInput) cls += entry.value;
      });
      observer.observe({ type: "layout-shift", buffered: true });
    } catch {
      // Navegador sem suporte a layout-shift — fica como lacuna (null).
    }
    try {
      const observer = new PerformanceObserver((list) => {
        const entries = list.getEntries();
        if (entries.length > 0) lcp = entries[entries.length - 1].startTime;
      });
      observer.observe({ type: "largest-contentful-paint", buffered: true });
    } catch {
      // Navegador sem suporte a LCP — fica como lacuna (null).
    }
    setTimeout(() => {
      result.cls = Math.round(cls * 10000) / 10000;
      result.lcpMs = lcp;
      resolve(result);
    }, settleMs);
  });
}

function readyLocator(page, ready) {
  const separator = ready.indexOf(":");
  const kind = ready.slice(0, separator);
  const value = ready.slice(separator + 1);
  if (kind === "heading") return page.getByRole("heading", { name: value });
  return page.getByText(value, { exact: false });
}

async function loginAndSaveState(baseUrl, credentials, storagePath) {
  const { request } = await import("@playwright/test");
  const apiContext = await request.newContext({
    baseURL: baseUrl,
    extraHTTPHeaders: {
      origin: baseUrl,
      "sec-fetch-site": "same-origin",
      "x-forwarded-for": "198.51.100.21",
    },
  });
  try {
    const response = await apiContext.post("/api/auth/sign-in/email", {
      data: { email: credentials.email, password: credentials.password },
    });
    if (!response.ok()) {
      fail(`login controlado falhou: HTTP ${response.status()} — ${await response.text()}`);
    }
    await apiContext.storageState({ path: storagePath });
  } finally {
    await apiContext.dispose();
  }
}

async function measureRoute(context, baseUrl, route, iteration, warmup) {
  const page = await context.newPage();
  const serverFn = [];
  page.on("requestfinished", (request) => {
    let url;
    try {
      url = new URL(request.url());
    } catch {
      return;
    }
    if (!url.pathname.includes("_serverFn")) return;
    let durationMs = null;
    try {
      const timing = request.timing();
      durationMs =
        Number.isFinite(timing.responseEnd) && timing.responseEnd >= 0 ? timing.responseEnd : null;
    } catch {
      // Sem timing disponível — fica como null na amostra.
    }
    serverFn.push({
      path: url.pathname,
      method: request.method(),
      durationMs,
      failed: request.failure() !== null,
    });
  });
  const startedAt = new Date().toISOString();
  const start = Date.now();
  const sample = {
    kind: "route",
    route: route.path,
    iteration,
    warmup,
    startedAt,
    status: null,
    error: null,
    readyMs: null,
    ttfbMs: null,
    fcpMs: null,
    lcpMs: null,
    cls: null,
    domContentLoadedMs: null,
    loadMs: null,
    serverFn,
  };
  try {
    const response = await page.goto(`${baseUrl}${route.path}`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    sample.status = response?.status() ?? null;
    await readyLocator(page, route.ready).first().waitFor({ state: "visible", timeout: 30_000 });
    await page.waitForTimeout(VITALS_SETTLE_MS);
    const vitals = await page.evaluate(collectVitals, VITALS_SETTLE_MS);
    Object.assign(sample, vitals);
    sample.readyMs = Date.now() - start;
  } catch (error) {
    sample.error = error instanceof Error ? error.message : String(error);
  } finally {
    await page.close();
  }
  return sample;
}

async function measureChat(context, baseUrl, iteration, warmup, expectedContent) {
  const page = await context.newPage();
  const sample = {
    kind: "chat",
    iteration,
    warmup,
    startedAt: new Date().toISOString(),
    status: null,
    error: null,
    sendMs: null,
  };
  try {
    await page.goto(`${baseUrl}/novo-produto`, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    const input = page.getByLabel("Mensagem para o consultor");
    await input.waitFor({ state: "visible", timeout: 30_000 });
    const previousResponses = await page.evaluate((content) => {
      const log = document.querySelector('[role="log"]');
      return log ? log.innerText.split(content).length - 1 : 0;
    }, expectedContent);
    const start = Date.now();
    await input.fill(`Mensagem controlada de baseline #${iteration}.`);
    await page.getByRole("button", { name: "Enviar" }).click();
    await page.waitForFunction(
      ({ content, previous }) => {
        const log = document.querySelector('[role="log"]');
        if (!log) return false;
        return log.innerText.split(content).length - 1 > previous;
      },
      { content: expectedContent, previous: previousResponses },
      { timeout: 30_000 },
    );
    sample.sendMs = Date.now() - start;
    sample.status = 200;
  } catch (error) {
    sample.error = error instanceof Error ? error.message : String(error);
    try {
      const logText = await page.locator('[role="log"]').innerText({ timeout: 1_000 });
      sample.detail = logText.trim().split("\n").slice(-3).join(" | ").slice(0, 300);
    } catch {
      // Sem log visível para anexar ao erro — a lacuna fica só com a mensagem.
    }
  } finally {
    await page.close();
  }
  return sample;
}

const AI_PROBE_SOURCE = `import { callModelForTests } from "@/lib/chat.functions";
import { GATEWAY_TOOLS } from "@/lib/ai/tool-registry";

async function main() {
  const samples = Number(process.env.PERF_AI_PROBE_SAMPLES ?? "3");
  const messages = [{ role: "user" as const, content: "ping de baseline" }];
  for (let index = 0; index < samples; index += 1) {
    await callModelForTests(messages, GATEWAY_TOOLS, new AbortController().signal);
  }
  console.log("AI_PROBE_OK");
}
await main();
`;

/**
 * Sonda direta da camada de modelo (mesma `callModel` do chat) para o item 6
 * quando o caminho HTTP do chat está inviável neste build. Roda em processo
 * filho com o fetch do gateway mockado; não toca a rede externa.
 */
async function runAiProbe(options, commandEnv, dir, sinks) {
  const probePath = path.join("/tmp/opencode", `perf-ai-probe-${process.pid}.mts`);
  await writeFile(probePath, AI_PROBE_SOURCE);
  const total = options.warmup + options.chatIterations;
  const hookUrl = `data:text/javascript,${encodeURIComponent(
    mockedFetchHookSource(commandEnv.PERF_AI_MOCK_CONTENT),
  )}`;
  const env = {
    ...commandEnv,
    PERF_AI_PROBE_SAMPLES: String(total),
    NODE_OPTIONS: [`--import=${hookUrl}`, commandEnv.NODE_OPTIONS].filter(Boolean).join(" "),
  };
  return new Promise((resolve) => {
    const child = spawn(
      path.join(root, "node_modules/.bin/tsx"),
      ["--tsconfig", "tsconfig.json", probePath],
      { cwd: root, env, stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.once("error", (error) => resolve({ code: 1, error: String(error), records: 0 }));
    child.once("close", async (code) => {
      let index = 0;
      for (const line of stdout.split("\n")) {
        const trimmed = line.trim();
        if (!trimmed.startsWith("{")) continue;
        let record;
        try {
          record = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (record.event !== "ai.model_attempt") continue;
        const warmup = index < options.warmup;
        const entry = {
          kind: "ai.model_attempt",
          timestamp: record.timestamp,
          model: record.model,
          attempt: record.attempt,
          durationMs: record.durationMs,
          outcome: record.outcome,
          phase: "ai:direct",
          iteration: warmup ? 0 : index - options.warmup + 1,
          warmup,
        };
        index += 1;
        sinks.aiAttempts.push(entry);
        await appendFile(path.join(dir, "ai-model-attempts.jsonl"), `${JSON.stringify(entry)}\n`);
      }
      await writeFile(path.join(dir, "ai-probe-output.txt"), stdout + stderr);
      resolve({ code: code ?? 1, records: index });
    });
  });
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    console.log(HELP);
    return 0;
  }
  const { databaseUrl, adminUrl } = assertLocalEnvironment(options);
  const baseUrl = `http://127.0.0.1:${options.port}`;
  const dir = options.dir;
  await mkdir(dir, { recursive: true });
  const startedAt = new Date().toISOString();
  const gaps = [];
  const notes = [];
  const env = buildCommandEnv(options, databaseUrl, adminUrl);
  const serverStdoutPath = path.join(dir, "server-stdout.txt");
  const sinks = { dir, contextTx: [], aiAttempts: [] };
  const logState = { offset: 0, records: 0 };
  let serverChild = null;
  let serverReused = false;
  let serverStartMs = null;
  let browser = null;
  let buildMs = null;
  let browserInfo = null;
  let preloadChunk = null;
  let aiProbe = null;
  let chatFailureDetail = null;

  // Raw é re-derivável: limpa apenas os jsonl desta execução.
  await writeFile(path.join(dir, "context-tx.jsonl"), "");
  await writeFile(path.join(dir, "ai-model-attempts.jsonl"), "");
  await writeFile(path.join(dir, "route-samples.jsonl"), "");
  await writeFile(path.join(dir, "chat-samples.jsonl"), "");

  try {
    if (!options.skipDb) {
      const dbCode = await runCommand("db", ["run", "db:up"], {
        env,
        logPath: path.join(dir, "db-up-output.txt"),
      });
      if (dbCode !== 0) {
        if (await tcpOk("127.0.0.1", 5432)) {
          notes.push(
            `npm run db:up falhou (exit ${dbCode}) por conflito de nome de container, mas 127.0.0.1:5432 já responde — banco local reusado.`,
          );
        } else {
          gaps.push(`npm run db:up falhou (exit ${dbCode}) e 127.0.0.1:5432 não respondeu.`);
        }
      }
      const seedCode = await runCommand("seed", ["run", "e2e:prepare"], {
        env,
        logPath: path.join(dir, "seed-output.txt"),
      });
      if (seedCode !== 0) {
        gaps.push(
          `npm run e2e:prepare falhou (exit ${seedCode}) — rotas autenticadas podem falhar.`,
        );
      }
    } else {
      gaps.push("--skip-db: seed/migrations não executados nesta captura.");
    }

    if (!options.skipBuild) {
      const buildStart = Date.now();
      const buildCode = await runCommand("build", ["run", "build"], {
        env,
        logPath: path.join(dir, "build-output.txt"),
      });
      buildMs = Date.now() - buildStart;
      if (buildCode !== 0) fail(`npm run build falhou (exit ${buildCode}) — captura abortada.`);
    } else {
      gaps.push("--skip-build: build reutilizado; ai.model_attempt pode estar ausente do .output.");
    }

    if (!options.skipBundle) {
      const bundleCode = await runCommand("bundle", ["run", "check:bundle"], {
        env,
        logPath: path.join(dir, "bundle-output.txt"),
      });
      if (bundleCode !== 0) gaps.push(`npm run check:bundle falhou (exit ${bundleCode}).`);
    } else {
      gaps.push("--skip-bundle: bundle-report.json não foi recalculado.");
    }
    try {
      const bundleReport = await readFile(path.join(root, ".artifacts/bundle-report.json"), "utf8");
      await writeFile(path.join(dir, "bundle-report.json"), bundleReport);
    } catch {
      gaps.push("bundle-report.json ausente em .artifacts — item 7 fica sem número.");
    }

    if (options.reuseServer && (await healthOk(options.port))) {
      serverReused = true;
      gaps.push(
        `Preview reusado em 127.0.0.1:${options.port}; o stdout do servidor em uso não é o desta captura — query/AI podem ficar sem atribuição.`,
      );
    } else if (await healthOk(options.port)) {
      fail(
        `Porta ${options.port} já responde /api/health/live; use --reuse-server para assumir o reuso ou --port para outra porta.`,
      );
    } else {
      preloadChunk = await findSsrPreloadChunk();
      const previewEnv = buildPreviewEnv(options, env, preloadChunk);
      await writeFile(serverStdoutPath, "");
      const serverStart = Date.now();
      serverChild = await startPreview(options, previewEnv, serverStdoutPath);
      const ready = await waitForHealth(options.port, 90_000);
      serverStartMs = Date.now() - serverStart;
      if (!ready) fail(`preview não ficou pronto em 127.0.0.1:${options.port}`);
    }

    if (options.noPlaywright) {
      gaps.push("--no-playwright: circuito de browser não executado (rotas, CWV e chat ausentes).");
    } else {
      try {
        const { chromium } = await import("@playwright/test");
        const storagePath = path.join("/tmp/opencode", `perf-storage-${process.pid}.json`);
        const credentials = { email: env.E2E_AUTH_EMAIL, password: env.E2E_AUTH_PASSWORD };
        await loginAndSaveState(baseUrl, credentials, storagePath);
        browser = await chromium.launch({ headless: true });
        browserInfo = { browser: "chromium", version: browser.version() };
        const context = await browser.newContext({
          storageState: storagePath,
          viewport: { width: 1366, height: 900 },
          extraHTTPHeaders: { "x-forwarded-for": "198.51.100.21" },
        });
        for (const route of ROUTES) {
          const total = options.warmup + options.iterations;
          let failures = 0;
          for (let round = 0; round < total; round += 1) {
            const warmup = round < options.warmup;
            const iteration = warmup ? 0 : round - options.warmup + 1;
            const sample = await measureRoute(context, baseUrl, route, iteration, warmup);
            if (sample.error) failures += 1;
            await appendFile(path.join(dir, "route-samples.jsonl"), `${JSON.stringify(sample)}\n`);
            await attributeNewRecords(
              serverStdoutPath,
              logState,
              `route:${route.path}`,
              iteration,
              warmup,
              sinks,
            );
          }
          if (failures > 0) {
            gaps.push(
              `Rota ${route.path}: ${failures} amostra(s) com erro (de ${total}, incluindo warmups).`,
            );
          }
        }
        for (let round = 0; round < options.warmup + options.chatIterations; round += 1) {
          const warmup = round < options.warmup;
          const iteration = warmup ? 0 : round - options.warmup + 1;
          const sample = await measureChat(
            context,
            baseUrl,
            iteration,
            warmup,
            env.PERF_AI_MOCK_CONTENT,
          );
          await appendFile(path.join(dir, "chat-samples.jsonl"), `${JSON.stringify(sample)}\n`);
          await attributeNewRecords(
            serverStdoutPath,
            logState,
            `chat:${iteration}`,
            iteration,
            warmup,
            sinks,
          );
          if (sample.error) {
            gaps.push(`Chat iteração ${iteration} (warmup=${warmup}): ${sample.error}`);
            if (!chatFailureDetail && sample.detail) chatFailureDetail = sample.detail;
          }
        }
        if (!sinks.aiAttempts.some((entry) => String(entry.phase).startsWith("chat:"))) {
          gaps.push(
            `Circuito HTTP de chat não gerou ai.model_attempt${chatFailureDetail ? ` — detalhe do cliente: ${chatFailureDetail}` : ""}.`,
          );
        }
        await context.close();
      } catch (error) {
        gaps.push(
          `Circuito Playwright indisponível/falhou: ${error instanceof Error ? error.message : String(error)}`,
        );
      } finally {
        if (browser) await browser.close().catch(() => undefined);
      }
    }

    try {
      aiProbe = await runAiProbe(options, env, dir, sinks);
      if (aiProbe.code !== 0) {
        gaps.push(
          `Probe direto de AI falhou (exit ${aiProbe.code}${aiProbe.error ? `: ${aiProbe.error}` : ""}).`,
        );
      }
    } catch (error) {
      gaps.push(
        `Probe direto de AI indisponível: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (sinks.aiAttempts.length === 0) {
      gaps.push("Nenhum ai.model_attempt coletado (nem no servidor, nem no probe direto).");
    }

    if (sinks.contextTx.length === 0) {
      gaps.push("Nenhum app.context_tx atribuído: query count/duration ficam sem número.");
    }
  } finally {
    stopPreview(serverChild);
    if (serverChild) await waitForExit(serverChild, 10_000);
    if (serverChild) killPreview(serverChild);
    await attributeNewRecords(serverStdoutPath, logState, "teardown", 0, true, sinks).catch(
      () => undefined,
    );
    const finishedAt = new Date().toISOString();
    const meta = {
      schemaVersion: 1,
      label: "CONTROLADO",
      commit: process.env.GITHUB_SHA ?? gitHead(),
      startedAt,
      finishedAt,
      baseUrl,
      port: options.port,
      serverReused,
      serverStartMs,
      buildMs,
      iterations: options.iterations,
      warmupIterations: options.warmup,
      chatIterations: options.chatIterations,
      routes: ROUTES.map((route) => ({ path: route.path, ready: route.ready })),
      node: process.version,
      platform: process.platform,
      playwright: browserInfo,
      aiMock: {
        enabled: true,
        endpoint: `https://${AI_MOCK_HOST}/v1/chat/completions`,
        latencyMs: options.aiMockLatencyMs,
        content: env.PERF_AI_MOCK_CONTENT,
      },
      database: {
        host: "127.0.0.1:5432",
        database: new URL(databaseUrl).pathname.replace(/^\//, ""),
        driver: env.DATABASE_DRIVER,
      },
      preloadChunk: preloadChunk?.name ?? null,
      aiProbe,
      notes: [
        "AI mockada em processo (fetch interceptado via NODE_OPTIONS) — NÃO é o gateway real.",
        "PostgreSQL 17 local em Docker — NÃO é Neon.",
        "Rotas autenticadas são client-side (ssr: false): prontidão medida após hidratação/dados.",
        ...(preloadChunk
          ? [
              `Build atual tem split circular de createCsrfMiddleware; pré-import de ${preloadChunk.name} via NODE_OPTIONS restaura a ordem de avaliação (workaround do harness, sem mudar lógica do app).`,
            ]
          : []),
        ...notes,
      ],
      gaps,
    };
    await writeFile(path.join(dir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
    console.log(
      `Captura concluída: ${sinks.contextTx.length} context_tx, ${sinks.aiAttempts.length} ai.model_attempt, ${gaps.length} lacuna(s).`,
    );
    console.log(path.join(dir, "meta.json"));
  }
  return 0;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    console.error(error);
    process.exitCode = 1;
  },
);
