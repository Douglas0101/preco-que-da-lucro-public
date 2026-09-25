import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs, validateFreezeWindow } from "../../scripts/m02-role-membership.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const tsx = resolve(root, "node_modules/.bin/tsx");
const script = resolve(root, "scripts/m02-role-membership.mjs");

const PROD_HOST = "ep-long-violet-aye9g0bn.c-5.us-east-2.aws.neon.tech";

function run(args: string[], env: Record<string, string>) {
  return spawnSync(tsx, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
}

describe("m02-role-membership parseArgs", () => {
  it("exige target-env e kind válido", () => {
    expect(parseArgs(["--target-env", "X", "--kind", "nope"]).error).toContain("kind");
    expect(parseArgs(["--kind", "drill-branch"]).error).toContain("target-env");
    expect(parseArgs(["--target-env=X", "--kind=drill-branch", "--dry-run"])).toEqual({
      targetEnv: "X",
      kind: "drill-branch",
      dryRun: true,
      out: undefined,
    });
  });
});

describe("m02-role-membership validateFreezeWindow (Emenda #3)", () => {
  const now = new Date("2026-09-11T12:00:00Z");
  it("vigente → ok; expirada/futura/malformada/ausente → não ok", () => {
    expect(
      validateFreezeWindow(
        {
          NEON_MIGRATION_FREEZE_START: "2026-09-11T00:00:00Z",
          NEON_MIGRATION_FREEZE_END: "2026-09-12T00:00:00Z",
        },
        now,
      ).ok,
    ).toBe(true);
    expect(
      validateFreezeWindow(
        {
          NEON_MIGRATION_FREEZE_START: "2026-09-10T00:00:00Z",
          NEON_MIGRATION_FREEZE_END: "2026-09-11T00:00:00Z",
        },
        now,
      ).ok,
    ).toBe(false);
    expect(
      validateFreezeWindow(
        {
          NEON_MIGRATION_FREEZE_START: "2026-09-12T00:00:00Z",
          NEON_MIGRATION_FREEZE_END: "2026-09-13T00:00:00Z",
        },
        now,
      ).ok,
    ).toBe(false);
    expect(validateFreezeWindow({}, now).ok).toBe(false);
    expect(
      validateFreezeWindow(
        { NEON_MIGRATION_FREEZE_START: "ontem", NEON_MIGRATION_FREEZE_END: "hoje" },
        now,
      ).ok,
    ).toBe(false);
  });
});

describe("m02-role-membership decisões PRÉ-conexão (sem rede, exit 3)", () => {
  it("drill-branch mirando produção → DENY pré-conexão", () => {
    const r = run(["--target-env", "RM_URL", "--kind", "drill-branch"], {
      RM_URL: `postgresql://fake:fake@${PROD_HOST}/neondb`,
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("DENY-pre-conexao");
    expect(r.stderr).toContain("Emenda #2");
  });
  it("cutover-window fora de janela → DENY pré-conexão (inclusive dry-run)", () => {
    const base = { RM_URL: `postgresql://fake:fake@${PROD_HOST}/neondb`, ALLOW_REMOTE_DB: "teste" };
    const outside = run(["--target-env", "RM_URL", "--kind", "cutover-window"], base);
    expect(outside.status).toBe(3);
    expect(outside.stderr).toContain("Emenda #3");
    const dryOutside = run(
      ["--target-env", "RM_URL", "--kind", "cutover-window", "--dry-run"],
      base,
    );
    expect(dryOutside.status).toBe(3);
  });
  it("URL malformada/ausente → fail-closed exit 2, sem vazar valor", () => {
    const bad = run(["--target-env", "RM_URL", "--kind", "drill-branch"], { RM_URL: "nao-e-url" });
    expect(bad.status).toBe(2);
    expect(bad.stderr).not.toContain("nao-e-url");
    const missing = run(["--target-env", "RM_URL_INEXISTENTE", "--kind", "drill-branch"], {});
    expect(missing.status).toBe(2);
  });
});
