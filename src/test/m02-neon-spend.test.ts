import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  BRANCH_USAGE_FIELDS,
  DEFAULT_API_BASE,
  branchesInventory,
  checkSpend,
  hostnamesOnly,
  parseArgs,
  planReport,
  preflight,
  projectInventory,
  skipReport,
  toHostname,
  type SpendFetch,
  type SpendRequestInit,
} from "../../scripts/m02-neon-spend.mjs";

// §12.6: inventário read-only; saída SOMENTE hostnames (nunca URL de conexão,
// chave, token ou id de projeto/branch); alerta é e-mail-only e não suspende
// compute — o relatório não pode vender isso como guardrail forte.
const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = resolve(root, "scripts/m02-neon-spend.mjs");
const FAKE_KEY = "neon-key-de-teste-1111";
const FAKE_PROJECT = "damp-forest-57346541";
const SECRET_IN_PAYLOAD = "SUPERSECRETO-NAO-PODE-VAZAR";
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

const PROJECT_PAYLOAD = {
  project: {
    id: FAKE_PROJECT,
    org_id: "org-do-teste",
    name: "preco-que-da-lucro",
    history_retention_seconds: 21600,
    connection_uri: `postgresql://app:${SECRET_IN_PAYLOAD}@ep-hidden-1.neon.tech/neondb`,
  },
};

const BRANCHES_PAYLOAD = {
  branches: [
    {
      id: "br-branch-um",
      name: "production",
      primary: true,
      default: true,
      created_at: "2026-08-17T00:00:00Z",
      host: "ep-hidden-1.neon.tech",
    },
    {
      id: "br-branch-dois",
      name: "develop",
      primary: false,
      default: false,
      created_at: "2026-09-13T00:00:00Z",
      compute_time_seconds: 12,
      active_time_seconds: 30,
    },
  ],
};

function stubFetch(payloads: unknown[], statuses: number[] = []) {
  const calls: { url: string; init?: SpendRequestInit }[] = [];
  const impl: SpendFetch = (url, init) => {
    calls.push(init === undefined ? { url } : { url, init });
    const index = calls.length - 1;
    const status = statuses[index] ?? 200;
    return Promise.resolve({
      ok: status >= 200 && status < 300,
      status,
      json: () => Promise.resolve(payloads[index] ?? {}),
    });
  };
  return { impl, calls };
}

describe("m02-neon-spend parseArgs e preflight (sem rede)", () => {
  it("aceita --plan e rejeita flag desconhecida", () => {
    expect(parseArgs(["--plan"])).toEqual({ plan: true });
    expect(parseArgs([])).toEqual({ plan: false });
    expect(parseArgs(["--nope"]).error).toContain("--nope");
  });
  it("exige os dois nomes de credencial sem ecoar valores", () => {
    expect(preflight({}).missing).toEqual(["NEON_API_KEY", "NEON_PROJECT_ID"]);
    expect(preflight({ NEON_API_KEY: FAKE_KEY }).missing).toEqual(["NEON_PROJECT_ID"]);
    expect(preflight({ NEON_API_KEY: FAKE_KEY, NEON_PROJECT_ID: FAKE_PROJECT }).ok).toBe(true);
  });
  it("skip rotulado declara que nenhuma chamada live foi feita", () => {
    const report = skipReport(["NEON_API_KEY"]) as Record<string, unknown>;
    expect(report.result).toBe("SKIP");
    expect(report.live_call).toBe(false);
    expect(String(report.detail)).toContain("NENHUMA chamada live foi feita");
  });
  it("--plan declara o que NÃO é tentado (spending_limit/consumption v2 — H-4)", () => {
    const text = JSON.stringify(planReport());
    expect(text).toContain("spending_limit");
    expect(text).toContain("consumption v2");
    expect(text).toContain("e-mail");
    expect(text).toContain("LOCKED");
  });
});

describe("m02-neon-spend saneamento de hostnames (norma do §12.6)", () => {
  it("URL com credencial vira somente host", () => {
    expect(toHostname(`postgresql://app:${SECRET_IN_PAYLOAD}@ep-x.neon.tech/neondb`)).toBe(
      "ep-x.neon.tech",
    );
    expect(toHostname("ep-y-pooler.c-5.us-east-2.aws.neon.tech")).toBe(
      "ep-y-pooler.c-5.us-east-2.aws.neon.tech",
    );
    expect(toHostname("usuario:senha@ep-z.neon.tech:5432/neondb")).toBe("ep-z.neon.tech");
  });
  it("nome de branch, id, contagem e timestamp não são hostnames", () => {
    expect(toHostname("production")).toBeNull();
    expect(toHostname("develop")).toBeNull();
    expect(toHostname("br-branch-um")).toBeNull();
    expect(toHostname(FAKE_PROJECT)).toBeNull();
    expect(toHostname("21600")).toBeNull();
    expect(toHostname("2026-09-05T22:37:46Z")).toBeNull();
    expect(toHostname("2026-09-05T22:37:46.123Z")).toBeNull();
    expect(toHostname("")).toBeNull();
    expect(toHostname(7)).toBeNull();
  });
  it("coleta recursiva, deduplicada e ordenada", () => {
    expect(
      hostnamesOnly({
        a: [{ host: "ep-b.neon.tech" }, "ep-a.neon.tech", "127.0.0.1"],
        b: "ep-a.neon.tech",
        c: "production",
      }),
    ).toEqual(["ep-a.neon.tech", "ep-b.neon.tech"]);
  });
});

describe("m02-neon-spend projeções", () => {
  it("projeto: janela de histórico e presença de org, sem id", () => {
    const inventory = projectInventory(PROJECT_PAYLOAD);
    expect(inventory).toEqual({
      project_ref_present: true,
      org_ref_present: true,
      history_retention_seconds: 21600,
    });
    expect(projectInventory({ project: {} }).history_retention_seconds).toBeNull();
    expect(projectInventory({ project: {} }).org_ref_present).toBe(false);
  });
  it("branches: contagens, campos confirmados e consumo TO-CONFIRM", () => {
    const inventory = branchesInventory(BRANCHES_PAYLOAD);
    expect(inventory.branches.count).toBe(2);
    expect(inventory.branches.primary_count).toBe(1);
    expect(inventory.branches.items[0].name).toBe("production");
    expect(inventory.branches.items[0].default).toBe(true);
    expect(inventory.branches.items[1].usage.compute_time_seconds).toBe(12);
    expect(inventory.branches.items[0].usage.compute_time_seconds).toBeNull();
    expect(inventory.usage_fields_present).toEqual(["active_time_seconds", "compute_time_seconds"]);
    expect(inventory.usage_fields_to_confirm).toEqual([
      "written_data_bytes",
      "data_transfer_bytes",
    ]);
    expect(BRANCH_USAGE_FIELDS).toHaveLength(4);
  });
});

describe("m02-neon-spend checkSpend (fetch mockado, somente GET)", () => {
  it("inventário OK: duas chamadas GET, saída sem segredo/id/URL de conexão", async () => {
    const { impl, calls } = stubFetch([PROJECT_PAYLOAD, BRANCHES_PAYLOAD]);
    const { report, exitCode } = await checkSpend({
      fetchImpl: impl,
      projectId: FAKE_PROJECT,
      apiKey: FAKE_KEY,
    });
    expect(exitCode).toBe(0);
    expect(report.result).toBe("OK");
    expect(calls.map((call) => call.url)).toEqual([
      `${DEFAULT_API_BASE}/projects/${FAKE_PROJECT}`,
      `${DEFAULT_API_BASE}/projects/${FAKE_PROJECT}/branches`,
    ]);
    for (const call of calls) {
      expect(call.init?.method).toBe("GET");
      expect(call.init?.headers?.Authorization).toBe(`Bearer ${FAKE_KEY}`);
    }
    expect(report.history_retention_seconds).toBe(21600);
    expect(report.hostnames).toEqual(["ep-hidden-1.neon.tech"]);
    const serialized = JSON.stringify(report);
    expect(serialized).not.toContain(SECRET_IN_PAYLOAD);
    expect(serialized).not.toContain(FAKE_KEY);
    expect(serialized).not.toContain(FAKE_PROJECT);
    expect(serialized).not.toContain("br-branch-um");
    expect(serialized).not.toContain("org-do-teste");
    expect(serialized).not.toContain("postgresql://");
    const guardrails = report.spending_guardrails as Record<string, string>;
    expect(guardrails.alert_channel).toContain("e-mail");
    expect(guardrails.alert_channel).toContain("NÃO suspende compute");
    expect(guardrails.spending_limit).toContain("H-4");
  });

  it("falha no GET do projeto → INCOMPLETE exit 2, sem segunda chamada", async () => {
    const { impl, calls } = stubFetch([{ message: "unauthorized" }], [401]);
    const { report, exitCode } = await checkSpend({
      fetchImpl: impl,
      projectId: FAKE_PROJECT,
      apiKey: FAKE_KEY,
    });
    expect(exitCode).toBe(2);
    expect(report.result).toBe("INCOMPLETE");
    expect(report.failed_call).toBe("project");
    expect(report.http_status).toBe(401);
    expect(calls).toHaveLength(1);
  });

  it("falha no GET de branches → INCOMPLETE exit 2", async () => {
    const { impl } = stubFetch([PROJECT_PAYLOAD, {}], [200, 500]);
    const { report, exitCode } = await checkSpend({
      fetchImpl: impl,
      projectId: FAKE_PROJECT,
      apiKey: FAKE_KEY,
    });
    expect(exitCode).toBe(2);
    expect(report.failed_call).toBe("branches");
    expect(report.http_status).toBe(500);
  });

  it("erro de rede com a chave na mensagem → redigida, exit 2", async () => {
    const impl: SpendFetch = () => Promise.reject(new Error(`timeout com ${FAKE_KEY}`));
    const { report, exitCode } = await checkSpend({
      fetchImpl: impl,
      projectId: FAKE_PROJECT,
      apiKey: FAKE_KEY,
    });
    expect(exitCode).toBe(2);
    expect(JSON.stringify(report)).not.toContain(FAKE_KEY);
    expect(String(report.detail)).toContain("<redigido>");
  });
});

describe("m02-neon-spend CLI (sem rede externa)", () => {
  it("--plan sai 0 com live_call falso mesmo com credencial presente", () => {
    const result = run(["--plan"], {
      NEON_API_KEY: FAKE_KEY,
      NEON_PROJECT_ID: FAKE_PROJECT,
      NEON_API_BASE: UNREACHABLE_API_BASE,
    });
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.mode).toBe("plan");
    expect(parsed.live_call).toBe(false);
    expect(result.stdout).toContain("spending_limit");
  });

  it("sem NEON_API_KEY → SKIP rotulado, exit 0, nenhuma chamada live", () => {
    const result = run([], envWithoutCredentials());
    expect(result.status).toBe(0);
    const parsed = JSON.parse(result.stdout);
    expect(parsed.result).toBe("SKIP");
    expect(parsed.live_call).toBe(false);
    expect(parsed.missing).toEqual(["NEON_API_KEY", "NEON_PROJECT_ID"]);
    expect(result.stdout).toContain("NENHUMA chamada live foi feita");
    expect(result.stdout).toContain("SOMENTE e-mail");
    expect(result.stdout).not.toContain("postgresql://");
  });

  it("argumento inválido → exit 2 com uso no stderr", () => {
    const result = run(["--nope"], envWithoutCredentials());
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--nope");
    expect(result.stderr).toContain("uso: node scripts/m02-neon-spend.mjs");
  });
});
