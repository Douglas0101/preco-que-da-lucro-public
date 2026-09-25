import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parseArgs } from "../../scripts/m02-cutover-t0.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("m02-cutover-t0 parseArgs", () => {
  it("aceita flags conhecidos e rejeita desconhecidos", () => {
    expect(parseArgs([])).toEqual({ outDir: undefined, skipSnapshot: false });
    expect(parseArgs(["--skip-snapshot"]).skipSnapshot).toBe(true);
    expect(parseArgs(["--out-dir", "docs/evidence/x"]).outDir).toBe("docs/evidence/x");
    expect(parseArgs(["--drop-production"]).error).toBeTruthy();
  });
});

describe("m02-cutover-t0 sem DATABASE_ADMIN_URL (dupla snapshot rotulada)", () => {
  it("--skip-snapshot não conecta e ainda assim exit 0 com rótulos (smoke de parsing)", () => {
    const env = { ...process.env } as NodeJS.ProcessEnv;
    delete env.DATABASE_ADMIN_URL;
    const r = spawnSync(
      "npm",
      ["run", "m02:cutover-t0", "--", "--skip-snapshot", "--out-dir", "/tmp/t0-unit"],
      {
        cwd: root,
        encoding: "utf8",
        env,
        timeout: 300_000,
      },
    );
    expect(r.stdout).toContain('"check":"dupla-snapshot"');
    expect(r.stdout).toContain("PENDING");
    expect(r.stdout).toContain('"check":"rls-probe-producao","status":"DIA-D"');
    expect(r.stdout).not.toContain("postgresql://");
  }, 240_000);
});
