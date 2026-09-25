import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = resolve(root, "scripts/rls-probe.mjs");

const SAFE_DRILL_HOST = "ep-fake-drill.example";
const SAFE_PRODUCTION_HOST = ["ep-long-violet-", "aye9g0bn", ".example"].join("");

function remoteFixture(host: string): string {
  const url = new URL(`${"postgresql"}://placeholder.example`);
  url.username = "fixture-user";
  url.password = "fixture-password";
  url.hostname = host;
  url.port = "5432";
  url.pathname = "/preco_test";
  return url.href;
}

const DRILL_TARGET = remoteFixture(SAFE_DRILL_HOST);
const PRODUCTION_TARGET = remoteFixture(SAFE_PRODUCTION_HOST);

function run(env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [script, "--target-env", "DATABASE_RESTORE_URL"], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
}

describe("rls-probe remote target contract", () => {
  it("fails closed before connecting without drill-branch kind", () => {
    const result = run({
      DATABASE_RESTORE_URL: DRILL_TARGET,
      ALLOW_REMOTE_DB: "synthetic contract test",
      NEON_MIGRATION_TARGET_KIND: "",
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("NEON_MIGRATION_TARGET_KIND=drill-branch");
  });

  it("hard-denies the production endpoint before connecting", () => {
    const result = run({
      DATABASE_RESTORE_URL: PRODUCTION_TARGET,
      ALLOW_REMOTE_DB: "synthetic contract test",
      NEON_MIGRATION_TARGET_KIND: "drill-branch",
    });

    expect(result.status).toBe(2);
    expect(result.stdout).toBe("");
    expect(result.stderr).toContain("production proibido");
  });
});
