import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  buildPlan,
  expectedJournalCount,
  maskUrl,
  parseArgs,
  preflight,
  preflightGuidance,
  utcDate,
} from "../../scripts/m02-v2b.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = resolve(root, "scripts/m02-v2b.mjs");

const MASK_HOST = "ep-b.neon.tech";
const MASK_FIXTURE = (() => {
  const url = new URL(`${"postgresql"}://placeholder.example`);
  url.username = "fixture-user";
  url.password = "fixture-password";
  url.hostname = MASK_HOST;
  url.port = "5432";
  url.pathname = "/preco_test";
  return url.href;
})();

function childArgs(argv: string[], env: NodeJS.ProcessEnv) {
  const result = spawnSync(process.execPath, [script, ...argv], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return result;
}

describe("m02-v2b parseArgs (sem rede)", () => {
  it("aceita --plan e rejeita flags desconhecidas", () => {
    expect(parseArgs(["--plan"])).toEqual({ plan: true });
    expect(parseArgs([])).toEqual({ plan: false });
    expect(parseArgs(["--nope"]).error).toContain("--nope");
    expect(parseArgs(["--drop-branch"]).error).toBeTruthy();
  });
});

describe("m02-v2b preflight (pré-conexão, sem rede)", () => {
  it("denuncia credencial ausente antes de qualquer conexão", () => {
    const check = preflight({});
    expect(check.ok).toBe(false);
    expect(check.missing).toEqual(["SUPABASE_MIGRATION_DATABASE_URL"]);
  });
  it("trata string vazia como ausente e URL presente como ok", () => {
    expect(preflight({ SUPABASE_MIGRATION_DATABASE_URL: "   " }).ok).toBe(false);
    expect(preflight({ SUPABASE_MIGRATION_DATABASE_URL: MASK_FIXTURE }).ok).toBe(true);
  });
  it("guidance aponta o dono humano D2 e o runbook, sem ecoar valores", () => {
    const guidance = preflightGuidance(["SUPABASE_MIGRATION_DATABASE_URL"]);
    expect(guidance).toContain("EXIT 3");
    expect(guidance).toContain("pré-conexão");
    expect(guidance).toContain("D2");
    expect(guidance).toContain("cutover-A4.md");
    expect(guidance).not.toContain("postgresql://");
  });
});

describe("m02-v2b --plan (sem conectar)", () => {
  const ctx = {
    date: "2026-09-07",
    projectId: "proj-x",
    parentBranchId: "br-parent-x",
    branchName: "dryrun-v2b-2026-09-07",
    expiresAt: "2026-09-08T00:00:00Z",
    outDir: "docs/evidence/cutover-prep-2026-09-07",
  };
  it("DAG completo em ordem com cleanup always por último passo", () => {
    const ids = buildPlan(ctx).map((step: { id: string }) => step.id);
    expect(ids).toEqual([
      "preflight",
      "create-branch",
      "connection-info",
      "migrate",
      "carga-legacy",
      "reconcile-legacy-branch",
      "schema-diff-legacy-branch",
      "emit-ledger-snippet",
      "cleanup",
    ]);
  });
  it("deriva a contagem esperada do journal canônico (nunca um literal)", () => {
    const journal = JSON.parse(
      readFileSync(resolve(root, "drizzle/meta/_journal.json"), "utf8"),
    ) as { entries: unknown[] };
    const expected = expectedJournalCount();
    expect(expected).toBe(journal.entries.length);
    // O passo `migrate` compara o journal do banco com esse número: um literal
    // reintroduzido no script quebra este teste na primeira migration nova, em
    // vez de quebrar o ensaio de cutover (0015 → ed29d4b, 0016 → esta correção).
    const migrate = buildPlan(ctx).find((step: { id: string }) => step.id === "migrate");
    expect(migrate?.expected).toContain(`= ${expected} `);
  });

  it("fail-closed: journal ilegível é erro acionável, nunca contagem 0", () => {
    expect(() => expectedJournalCount("/diretorio-inexistente")).toThrow(
      /journal do Drizzle ilegível em drizzle\/meta\/_journal\.json/,
    );
  });

  it("CLI imprime o DAG e sai 0 mesmo SEM credencial alguma", () => {
    const env = { ...process.env } as NodeJS.ProcessEnv;
    delete env.SUPABASE_MIGRATION_DATABASE_URL;
    const result = childArgs(["--plan"], env);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("nenhuma conexão foi feita");
    expect(result.stdout).toContain("create-branch");
    expect(result.stdout).toContain("cleanup");
    expect(result.stdout).toMatch(/dryrun-v2b-\d{4}-\d{2}-\d{2}/);
    expect(result.stdout).not.toContain("postgresql://");
  });
});

describe("m02-v2b execução sem credencial (exit 3 pré-conexão)", () => {
  it("exit 3, log antes-de-qualquer-conexao, nenhum socket, orientação D2", () => {
    const env = { ...process.env } as NodeJS.ProcessEnv;
    delete env.SUPABASE_MIGRATION_DATABASE_URL;
    const result = childArgs([], env);
    expect(result.status).toBe(3);
    expect(result.stdout).toContain('"event":"preflight"');
    expect(result.stdout).toContain("antes-de-qualquer-conexao");
    expect(result.stdout).toContain('"sockets_abertos":0');
    expect(result.stderr).toContain("EXIT 3 (pré-conexão; nenhum socket foi aberto)");
    expect(result.stderr).toContain("D2");
  });
});

describe("m02-v2b máscara de segredos", () => {
  it("só hostname; malformada nunca vaza valor", () => {
    expect(maskUrl(MASK_FIXTURE)).toBe(MASK_HOST);
    expect(maskUrl("não-é-url")).toBe("<malformada>");
  });
  it("utcDate usa data UTC", () => {
    expect(utcDate(new Date("2026-09-07T01:30:00Z"))).toBe("2026-09-07");
    expect(utcDate(new Date("2026-09-06T23:30:00Z"))).toBe("2026-09-06");
  });
});
