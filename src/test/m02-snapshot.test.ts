import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  parseArgs,
  sha256OfFile,
  TRIO_FILENAMES,
  trioPreexists,
  buildTrioMetadata,
} from "../../scripts/m02-snapshot.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = resolve(root, "scripts/m02-snapshot.mjs");

function run(args: string[], env: Record<string, string>) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    env: { ...process.env, ...env },
    timeout: 30_000,
  });
}

const NO_START = '"event":"start"';
const SAFE_DIRECT_HOST = "ep-fake-direct.example";
const SAFE_POOLER_HOST = "ep-fake-pooler.example";

function remoteFixture(host: string): string {
  const url = new URL(`${"postgresql"}://placeholder.example`);
  url.username = "fake";
  url.password = "fake";
  url.hostname = host;
  url.port = "5432";
  url.pathname = "/preco_test";
  return url.href;
}

const FAKE_DIRECT = remoteFixture(SAFE_DIRECT_HOST);
const FAKE_POOLER = remoteFixture(SAFE_POOLER_HOST);

async function tmpDir(prefix: string) {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  return mkdtempSync(join(tmpdir(), prefix));
}

describe("m02-snapshot parseArgs", () => {
  it("defaults e overrides", () => {
    expect(parseArgs([])).toEqual({
      sourceEnv: "DATABASE_ADMIN_URL",
      outDir: "artifacts/snapshots",
      origin: "production",
      outDirExplicit: false,
    });
    expect(parseArgs(["--source-env=MY_ENV", "--origin=drill"]).sourceEnv).toBe("MY_ENV");
    expect(parseArgs(["--out-dir", "algum/dir"]).outDirExplicit).toBe(true);
    expect(parseArgs(["--nope"]).error).toBeTruthy();
  });
});

describe("m02-snapshot decisões PRÉ-conexão", () => {
  it("sem motivo → exit 3 com DENY pré-conexão (Emenda #4, norma §5)", () => {
    const env = { ...process.env } as Record<string, string>;
    delete env.ALLOW_REMOTE_DB;
    const r = run([], {
      ...env,
      DATABASE_ADMIN_URL: FAKE_DIRECT,
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("DENY-pre-conexao");
    expect(r.stderr).toContain("motivo obrigatório");
  });
  it("host -pooler → exit 3 (dump é DIRECT only)", () => {
    const r = run([], {
      ALLOW_REMOTE_DB: "teste",
      DATABASE_ADMIN_URL: FAKE_POOLER,
    });
    expect(r.status).toBe(3);
    expect(r.stderr).toContain("DIRECT");
    expect(r.stderr).not.toContain("fake:fake");
  });
  it("env ausente → exit 2 fail-closed sem imprimir valores", () => {
    const env = { ALLOW_REMOTE_DB: "teste" } as Record<string, string>;
    const r = run(["--source-env", "SNAP_URL_INEXISTENTE"], env);
    expect(r.status).toBe(2);
  });
});

describe("m02-snapshot sha256", () => {
  it("hash estável sobre conteúdo", async () => {
    const { writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = await tmpDir("snap-");
    writeFileSync(join(dir, "a"), "conteudo");
    expect(sha256OfFile(join(dir, "a"))).toBe(sha256OfFile(join(dir, "a")));
    expect(sha256OfFile(join(dir, "a"))).toHaveLength(64);
  });
});

describe("S1 produtor DP5=(b) — 5 casos", () => {
  it("1. default inalterado (sem --out-dir: layout legado + seq anti-sobrescrita)", () => {
    const parsed = parseArgs([]);
    expect(parsed).toMatchObject({
      outDir: "artifacts/snapshots",
      outDirExplicit: false,
    });
    expect(TRIO_FILENAMES).toEqual(["dump.pgc", "dump.pgc.sha256", "metadata.json"]);
    expect(trioPreexists("/caminho/que/nao/existe/s1")).toEqual([]);
  });

  it("2. trio nomeado + fail-closed se trio pré-existe (pré-conexão, zero socket)", async () => {
    const { writeFileSync, readFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const dir = await tmpDir("s1-trio-");
    for (const name of TRIO_FILENAMES) writeFileSync(join(dir, name as string), "prova-anterior");
    const before = TRIO_FILENAMES.map((n) => readFileSync(join(dir, n as string), "utf8"));
    const r = run(["--out-dir", dir], {
      ALLOW_REMOTE_DB: "teste-s1",
      DATABASE_ADMIN_URL: FAKE_DIRECT,
    });
    expect(r.status).toBe(2);
    expect(r.stderr).toMatch(/já existe|fail-closed/);
    expect(r.stdout).not.toContain(NO_START);
    const after = TRIO_FILENAMES.map((n) => readFileSync(join(dir, n as string), "utf8"));
    expect(after).toEqual(before);
  });

  it("3. metadata do trio completa (pura, sem rede)", () => {
    const meta = buildTrioMetadata({
      origin: "production",
      sourceEnv: "DATABASE_ADMIN_URL",
      host: SAFE_DIRECT_HOST,
      clientVersion: "pg_dump (PostgreSQL) 17.5",
      serverVersion: "17.5",
      inRecovery: "f",
      sizeBytes: 123,
      durationMs: 456,
      sha256: "a".repeat(64),
      motivo: "teste-s1",
      startedAt: "2026-09-07T18:00:00.000Z",
      finishedAt: "2026-09-07T18:00:01.000Z",
    }) as Record<string, unknown>;
    expect(meta).toMatchObject({
      producer: "m02:snapshot",
      source: "production",
      connection_kind: "direct",
      read_only: true,
      motivo: "teste-s1",
      created_at: "2026-09-07T18:00:00.000Z",
      sha256: "a".repeat(64),
      size_bytes: 123,
    });
  });

  it("4. pooler recusado nos dois modos (pré-conexão, zero socket)", async () => {
    const dir = await tmpDir("s1-pooler-");
    for (const args of [[], ["--out-dir", dir]] as string[][]) {
      const r = run(args, {
        ALLOW_REMOTE_DB: "teste-s1",
        DATABASE_ADMIN_URL: FAKE_POOLER,
      });
      expect(r.status).toBe(3);
      expect(r.stderr).toContain("DENY-pre-conexao");
      expect(r.stderr).toContain("DIRECT");
      expect(r.stdout).not.toContain(NO_START);
      expect(r.stderr).not.toContain("fake:fake");
    }
  });

  it("5. motivo ausente recusado nos dois modos (pré-conexão, zero socket)", async () => {
    const dir = await tmpDir("s1-motivo-");
    const env = { ...process.env } as Record<string, string>;
    delete env.ALLOW_REMOTE_DB;
    for (const args of [[], ["--out-dir", dir]] as string[][]) {
      const r = run(args, { ...env, DATABASE_ADMIN_URL: FAKE_DIRECT });
      expect(r.status).toBe(3);
      expect(r.stderr).toContain("DENY-pre-conexao");
      expect(r.stderr).toContain("motivo obrigatório");
      expect(r.stdout).not.toContain(NO_START);
    }
  });
});
