import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_API_BASE,
  MIN_RETENTION_SECONDS,
  checkPitr,
  evaluateWindow,
  parseArgs,
  planReport,
  preflight,
  readRetentionSeconds,
  redactSecret,
  skipReport,
  type PitrFetch,
  type PitrRequestInit,
} from "../../scripts/m02-pitr-check.mjs";

// §13.7: o check é read-only (nenhum PATCH), não inventa forma de resposta sem
// chave, e sem NEON_API_KEY faz SKIP ROTULADO (exit 0) declarando que nenhuma
// chamada live foi feita. Toda a lógica de rede é exercitada com fetch mockado.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = resolve(root, "scripts/m02-pitr-check.mjs");
const FAKE_KEY = "neon-key-de-teste-0000";
// Base inalcançável: se uma regressão fizer o modo --plan/skip tentar rede, o
// teste falha de forma determinística em vez de tocar a API real.
const UNREACHABLE_API_BASE = "http://127.0.0.1:1/api/v2";

function run(args: string[], env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

function envWithoutCredentials() {
  const env = { ...process.env, NEON_API_BASE: UNREACHABLE_API_BASE } as NodeJS.ProcessEnv;
  delete env.NEON_API_KEY;
  delete env.NEON_PROJECT_ID;
  return env;
}

function stubFetch(payload: unknown, status = 200) {
  const calls: { url: string; init?: PitrRequestInit }[] = [];
  const impl: PitrFetch = (url, init) => {
    calls.push(init === undefined ? { url } : { url, init });
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(payload),
    });
  };
  return { impl, calls };
}

const PROJECT_PAYLOAD = {
  project: { id: "damp-forest-57346541", history_retention_seconds: 21600 },
};

describe("m02-pitr-check parseArgs (sem rede)", () => {
  it("defaults: modo run com mínimo de 7 dias (SDD §16.6)", () => {
    expect(parseArgs([])).toEqual({ plan: false, minSeconds: MIN_RETENTION_SECONDS });
    expect(MIN_RETENTION_SECONDS).toBe(604800);
  });
  it("aceita --plan e --min-sec nas duas formas", () => {
    expect(parseArgs(["--plan"]).plan).toBe(true);
    expect(parseArgs(["--min-sec", "60"]).minSeconds).toBe(60);
    expect(parseArgs(["--min-sec=60"]).minSeconds).toBe(60);
  });
  it("rejeita flag desconhecida e valor não-inteiro de --min-sec", () => {
    expect(parseArgs(["--nope"]).error).toContain("--nope");
    expect(parseArgs(["--min-sec"]).error).toContain("--min-sec");
    expect(parseArgs(["--min-sec=abc"]).error).toContain("--min-sec");
    expect(parseArgs(["--min-sec=0"]).error).toContain("--min-sec");
    expect(parseArgs(["--min-sec=12abc"]).error).toContain("--min-sec");
  });
});

describe("m02-pitr-check preflight (pré-conexão, sem rede)", () => {
  it("denuncia nomes ausentes sem ecoar valores", () => {
    const check = preflight({});
    expect(check.ok).toBe(false);
    expect(check.missing).toEqual(["NEON_API_KEY", "NEON_PROJECT_ID"]);
    expect(preflight({ NEON_API_KEY: "   " }).missing).toEqual(["NEON_API_KEY", "NEON_PROJECT_ID"]);
    expect(preflight({ NEON_API_KEY: FAKE_KEY }).missing).toEqual(["NEON_PROJECT_ID"]);
  });
  it("skip rotulado declara que a janela NÃO foi medida e live_call falso", () => {
    const report = skipReport(["NEON_API_KEY"]) as Record<string, unknown>;
    expect(report.result).toBe("SKIP");
    expect(report.live_call).toBe(false);
    expect(String(report.detail)).toContain("NENHUMA chamada live foi feita");
    expect(JSON.stringify(report)).not.toContain(FAKE_KEY);
  });
  it("--plan imprime o contrato de endpoints sem chave e com live_call falso", () => {
    const report = planReport(MIN_RETENTION_SECONDS) as Record<string, unknown>;
    expect(report.mode).toBe("plan");
    expect(report.live_call).toBe(false);
    expect(JSON.stringify(report)).toContain("PATCH");
    expect(JSON.stringify(report)).toContain("history_retention_seconds");
    expect(JSON.stringify(report)).toContain("LOCKED");
  });
});

describe("m02-pitr-check leitura e veredito da janela", () => {
  it("lê o envelope {project:{…}} e o objeto plano; recusa não-inteiro", () => {
    expect(readRetentionSeconds(PROJECT_PAYLOAD)).toBe(21600);
    expect(readRetentionSeconds({ history_retention_seconds: 604800 })).toBe(604800);
    expect(readRetentionSeconds({ project: { history_retention_seconds: "21600" } })).toBeNull();
    expect(readRetentionSeconds({ project: {} })).toBeNull();
    expect(readRetentionSeconds(null)).toBeNull();
    expect(readRetentionSeconds({ project: { history_retention_seconds: 21600.5 } })).toBeNull();
  });
  it("PASS no mínimo exato, FAIL abaixo (com déficit), DESCONHECIDO sem campo", () => {
    expect(evaluateWindow(604800, 604800).status).toBe("PASS");
    const fail = evaluateWindow(21600, 604800);
    expect(fail.status).toBe("FAIL");
    expect(fail.deficit_seconds).toBe(604800 - 21600);
    expect(fail.detail).toContain("BAK-01b ABERTO");
    expect(evaluateWindow(null, 604800).status).toBe("DESCONHECIDO");
  });
  it("redige a chave de qualquer mensagem de erro", () => {
    expect(redactSecret(`boom ${FAKE_KEY} fim`, FAKE_KEY)).toBe("boom <redigido> fim");
    expect(redactSecret("sem segredo", FAKE_KEY)).toBe("sem segredo");
  });
});

describe("m02-pitr-check checkPitr (fetch mockado, nunca PATCH)", () => {
  it("HTTP 200 com janela de 6 h → FAIL exit 1 e nenhum PATCH emitido", async () => {
    const { impl, calls } = stubFetch(PROJECT_PAYLOAD);
    const { report, exitCode } = await checkPitr({
      fetchImpl: impl,
      projectId: "damp-forest-57346541",
      apiKey: FAKE_KEY,
    });
    expect(exitCode).toBe(1);
    expect(report.result).toBe("FAIL");
    expect(report.history_retention_seconds).toBe(21600);
    expect(report.history_retention_days).toBe(0.25);
    expect(report.min_seconds).toBe(MIN_RETENTION_SECONDS);
    expect(report.deficit_seconds).toBe(604800 - 21600);
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe(`${DEFAULT_API_BASE}/projects/damp-forest-57346541`);
    expect(calls[0].init?.method).toBe("GET");
    expect(calls[0].init?.headers?.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    // Nem a chave nem o id de projeto podem aparecer na saída publicável.
    expect(JSON.stringify(report)).not.toContain(FAKE_KEY);
    expect(report.project_ref_present).toBe(true);
    expect(JSON.stringify(report)).not.toContain("damp-forest-57346541");
  });

  it("janela de 7 dias → PASS exit 0", async () => {
    const { impl } = stubFetch({ project: { history_retention_seconds: 604800 } });
    const { report, exitCode } = await checkPitr({
      fetchImpl: impl,
      projectId: "proj-x",
      apiKey: FAKE_KEY,
    });
    expect(exitCode).toBe(0);
    expect(report.result).toBe("PASS");
    expect(report.history_retention_days).toBe(7);
  });

  it("HTTP ≠ 200 → INCOMPLETE exit 2 (fail-closed, janela não medida)", async () => {
    const { impl } = stubFetch({ message: "nope" }, 401);
    const { report, exitCode } = await checkPitr({
      fetchImpl: impl,
      projectId: "proj-x",
      apiKey: FAKE_KEY,
    });
    expect(exitCode).toBe(2);
    expect(report.result).toBe("INCOMPLETE");
    expect(report.fail_closed).toBe(true);
    expect(report.http_status).toBe(401);
  });

  it("campo ausente na resposta → INCOMPLETE exit 2, nunca PASS", async () => {
    const { impl } = stubFetch({ project: { id: "proj-x" } });
    const { report, exitCode } = await checkPitr({
      fetchImpl: impl,
      projectId: "proj-x",
      apiKey: FAKE_KEY,
    });
    expect(exitCode).toBe(2);
    expect(report.result).toBe("DESCONHECIDO");
    expect(report.history_retention_seconds).toBeNull();
  });

  it("falha de rede com a chave na mensagem → redigida, exit 2", async () => {
    const impl: PitrFetch = () => Promise.reject(new Error(`socket caiu com ${FAKE_KEY}`));
    const { report, exitCode } = await checkPitr({
      fetchImpl: impl,
      projectId: "proj-x",
      apiKey: FAKE_KEY,
    });
    expect(exitCode).toBe(2);
    expect(report.result).toBe("INCOMPLETE");
    expect(JSON.stringify(report)).not.toContain(FAKE_KEY);
    expect(String(report.detail)).toContain("<redigido>");
  });
});

describe("m02-pitr-check CLI (sem rede externa)", () => {
  it("--plan sai 0 e não faz chamada live mesmo com credencial presente", () => {
    const result = run(["--plan"], {
      NEON_API_KEY: FAKE_KEY,
      NEON_PROJECT_ID: "proj-x",
      NEON_API_BASE: UNREACHABLE_API_BASE,
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.mode).toBe("plan");
    expect(parsed.live_call).toBe(false);
    expect(result.stdout).toContain("history_retention_seconds");
  });

  it("sem NEON_API_KEY → SKIP rotulado, exit 0, nenhuma chamada live", () => {
    const result = run([], envWithoutCredentials());
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.result).toBe("SKIP");
    expect(parsed.live_call).toBe(false);
    expect(parsed.missing).toEqual(["NEON_API_KEY", "NEON_PROJECT_ID"]);
    expect(result.stdout).toContain("NENHUMA chamada live foi feita");
    expect(result.stdout).toContain("NÃO foi medida");
    expect(result.stdout).not.toContain("postgresql://");
  });

  it("com NEON_API_KEY mas sem NEON_PROJECT_ID → SKIP rotulado, exit 0", () => {
    const env = envWithoutCredentials();
    env.NEON_API_KEY = FAKE_KEY;
    const result = run([], env);
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout).missing).toEqual(["NEON_PROJECT_ID"]);
  });

  it("argumento inválido → exit 2 com uso no stderr", () => {
    const result = run(["--min-sec=abc"], envWithoutCredentials());
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--min-sec inválido");
    expect(result.stderr).toContain("uso: node scripts/m02-pitr-check.mjs");
  });
});
