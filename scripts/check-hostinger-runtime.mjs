import { access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const entry = path.join(root, ".output/server/index.mjs");
const startupTimeoutMs = 8_000;
const requestTimeoutMs = 2_000;
const pollIntervalMs = 100;

async function assertEntryExists() {
  try {
    await access(entry);
  } catch {
    throw new Error(
      "Artefato de produção ausente: execute npm run build antes de npm run check:hostinger-runtime",
    );
  }
}

async function reservePort() {
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  const address = server.address();
  await new Promise((resolve, reject) => {
    server.close((error) => (error ? reject(error) : resolve()));
  });
  if (!address || typeof address === "string")
    throw new Error("Não foi possível reservar uma porta");
  return address.port;
}

function redact(value) {
  return value
    .replace(/\b(?:postgres(?:ql)?|mysql|redis):\/\/[^\s"']+/gi, "[connection-redacted]")
    .replace(/\b(?:bearer\s+)[^\s]+/gi, "Bearer [redacted]")
    .replace(/\b(api[_-]?key|secret|password|token)\s*[:=]\s*[^\s,}]+/gi, "$1=[redacted]");
}

async function request(url, expectedStatus) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), requestTimeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    const body = await response.text();
    if (response.status !== expectedStatus) {
      throw new Error(
        `${url} respondeu ${response.status}; esperado ${expectedStatus}; body=${body}`,
      );
    }
    return body;
  } finally {
    clearTimeout(timeout);
  }
}

async function waitForLive(url, child, output) {
  const deadline = Date.now() + startupTimeoutMs;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) {
      throw new Error(`processo encerrou com código ${child.exitCode}: ${redact(output())}`);
    }
    try {
      await request(url, 200);
      return;
    } catch (error) {
      lastError = error;
      await sleep(pollIntervalMs);
    }
  }
  throw new Error(`timeout aguardando liveness: ${lastError?.message ?? "erro desconhecido"}`);
}

async function stopProcess(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  const exit = Promise.race([once(child, "exit"), sleep(2_000).then(() => "timeout")]);
  if ((await exit) === "timeout" && child.exitCode === null) child.kill("SIGKILL");
}

async function runCase(name, portMode) {
  const port = await reservePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  const output = [];
  const env = {
    ...process.env,
    NODE_ENV: "production",
    DATABASE_DRIVER: "node-postgres",
    DATABASE_URL: "postgresql://127.0.0.1:1/unavailable?connect_timeout=1",
    BETTER_AUTH_URL: baseUrl,
    BETTER_AUTH_SECRET: randomBytes(32).toString("hex"),
    AUTH_TRUSTED_ORIGINS: baseUrl,
    NITRO_HOST: undefined,
    HOST: undefined,
    PORT: undefined,
    NITRO_PORT: undefined,
  };

  if (portMode === "NITRO_PORT") {
    env.PORT = "1";
    env.NITRO_PORT = String(port);
    env.HOST = "192.0.2.1";
    env.NITRO_HOST = "127.0.0.1";
  } else {
    env.PORT = String(port);
    env.HOST = "127.0.0.1";
  }

  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (chunk) => output.push(String(chunk)));
  child.stderr.on("data", (chunk) => output.push(String(chunk)));

  try {
    await waitForLive(`${baseUrl}/api/health/live`, child, () => output.join(""));
    await request(`${baseUrl}/api/health/ready`, 503);
    console.log(`PASS ${name}: live=200 ready=503 port=${port}`);
  } catch (error) {
    throw new Error(
      `${name}: ${error instanceof Error ? error.message : String(error)}\n${redact(output.join(""))}`,
    );
  } finally {
    await stopProcess(child);
  }
}

await assertEntryExists();
await runCase("NITRO_PORT/NITRO_HOST", "NITRO_PORT");
await runCase("PORT/HOST", "PORT");
console.log("Hostinger runtime smoke passed: Node/Nitro, live e degraded readiness.");
