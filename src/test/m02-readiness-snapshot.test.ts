import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { describe, expect, it, afterEach } from "vitest";
import { evaluateSnapshotDir, checkSnapshotFromRoot } from "../../scripts/m02-readiness.mjs";

// N-5/N-6 (Emenda #6, DP5=(b)): consumidor valida o trio exato; frescor por
// created_at; mtime nunca decide; relógio controlado; tmpdir; sem rede/banco.
const FIXED_NOW = Date.parse("2026-09-07T12:00:00.000Z");
const DUMP_BYTES = "DUMP-BYTES-FIXOS-S1";
const dumpHash = createHash("sha256").update(DUMP_BYTES).digest("hex");

const tmpRoots: string[] = [];
afterEach(() => {
  while (tmpRoots.length > 0) rmSync(tmpRoots.pop() as string, { recursive: true, force: true });
});

function freshRoot() {
  const dir = mkdtempSync(join(tmpdir(), "s1-fresco-"));
  tmpRoots.push(dir);
  return dir;
}

function writeTrio(
  root: string,
  name: string,
  opts: {
    ageH?: number;
    futureH?: number;
    tamperDump?: boolean;
    tamperSidecar?: boolean;
    metaOverrides?: Record<string, unknown>;
    dropMeta?: string[];
    noSidecar?: boolean;
    noMeta?: boolean;
  } = {},
) {
  const dir = join(root, name);
  mkdirSync(dir, { recursive: true });
  const bytes = opts.tamperDump ? `${DUMP_BYTES}-adulterado` : DUMP_BYTES;
  writeFileSync(join(dir, "dump.pgc"), bytes);
  // Divergência real: declarado/sidecar apontam o conteúdo íntegro, dump foi adulterado.
  const declared =
    opts.tamperDump && !opts.tamperSidecar
      ? dumpHash
      : createHash("sha256").update(bytes).digest("hex");
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (!opts.noSidecar) {
    writeFileSync(
      join(dir, "dump.pgc.sha256"),
      `${opts.tamperSidecar ? "b".repeat(64) : declared}  dump.pgc\n`,
    );
  }
  if (!opts.noMeta) {
    const created = new Date(
      FIXED_NOW + (opts.futureH ?? 0) * 3_600_000 - (opts.ageH ?? 1) * 3_600_000,
    ).toISOString();
    const meta: Record<string, unknown> = {
      producer: "m02:snapshot",
      source: "production",
      connection_kind: "direct",
      read_only: true,
      motivo: "teste-s1",
      created_at: created,
      sha256: declared,
      ...(opts.metaOverrides ?? {}),
    };
    for (const key of opts.dropMeta ?? []) delete meta[key];
    writeFileSync(join(dir, "metadata.json"), JSON.stringify(meta));
  }
  return dir;
}

describe("N-5/N-6 consumidor snapshot-fresco", () => {
  it("trio válido com <24h → ok/PASS", () => {
    const root = freshRoot();
    const dir = writeTrio(root, "d1", { ageH: 1 });
    expect(evaluateSnapshotDir(dir, FIXED_NOW).ok).toBe(true);
    const verdict = checkSnapshotFromRoot(root, FIXED_NOW);
    expect(verdict.status).toBe("PASS");
    expect(verdict.detail).toContain("d1");
  });

  it("mudança só de mtime não ressuscita trio stale (mtime ignorado)", () => {
    const root = freshRoot();
    const dir = writeTrio(root, "d1", { ageH: 25 });
    const dumpPath = join(dir, "dump.pgc");
    const now = new Date(FIXED_NOW);
    utimesSync(dumpPath, now, now);
    expect(readFileSync(dumpPath, "utf8")).toBe(DUMP_BYTES);
    expect(evaluateSnapshotDir(dir, FIXED_NOW).ok).toBe(true);
    expect(checkSnapshotFromRoot(root, FIXED_NOW).status).toBe("FAIL");
  });

  it("idade ≥24h por created_at → FAIL", () => {
    const root = freshRoot();
    writeTrio(root, "d1", { ageH: 24 });
    writeTrio(root, "d2", { ageH: 48 });
    expect(checkSnapshotFromRoot(root, FIXED_NOW).status).toBe("FAIL");
  });

  it("created_at futura → nunca PASS", () => {
    const root = freshRoot();
    const dir = writeTrio(root, "d1", { ageH: 0, futureH: 2 });
    const verdict = evaluateSnapshotDir(dir, FIXED_NOW);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/futura/);
    expect(checkSnapshotFromRoot(root, FIXED_NOW).status).toBe("FAIL");
  });

  it("hash divergente (dump adulterado) → nunca PASS", () => {
    const root = freshRoot();
    const dir = writeTrio(root, "d1", { ageH: 1, tamperDump: true });
    const verdict = evaluateSnapshotDir(dir, FIXED_NOW);
    expect(verdict.ok).toBe(false);
    expect(verdict.reasons.join(" ")).toMatch(/divergente/);
  });

  it("sidecar divergente → nunca PASS", () => {
    const root = freshRoot();
    const dir = writeTrio(root, "d1", { ageH: 1, tamperSidecar: true });
    expect(evaluateSnapshotDir(dir, FIXED_NOW).ok).toBe(false);
  });

  it("producer/source errados → nunca PASS", () => {
    const root = freshRoot();
    const d1 = writeTrio(root, "d1", { ageH: 1, metaOverrides: { producer: "outro" } });
    const d2 = writeTrio(root, "d2", { ageH: 1, metaOverrides: { source: "staging" } });
    expect(evaluateSnapshotDir(d1, FIXED_NOW).ok).toBe(false);
    expect(evaluateSnapshotDir(d2, FIXED_NOW).ok).toBe(false);
    expect(checkSnapshotFromRoot(root, FIXED_NOW).status).toBe("FAIL");
  });

  it("connection_kind ≠ direct / read_only falso / motivo vazio → nunca PASS", () => {
    const root = freshRoot();
    const cases = [
      writeTrio(root, "c1", { ageH: 1, metaOverrides: { connection_kind: "pooled" } }),
      writeTrio(root, "c2", { ageH: 1, metaOverrides: { read_only: false } }),
      writeTrio(root, "c3", { ageH: 1, metaOverrides: { motivo: "  " } }),
    ];
    for (const dir of cases) expect(evaluateSnapshotDir(dir, FIXED_NOW).ok).toBe(false);
  });

  it("metadata ausente ou incompleta → nunca PASS", () => {
    const root = freshRoot();
    const d1 = writeTrio(root, "d1", { ageH: 1, noMeta: true });
    const d2 = writeTrio(root, "d2", { ageH: 1, dropMeta: ["created_at", "sha256"] });
    expect(evaluateSnapshotDir(d1, FIXED_NOW).ok).toBe(false);
    expect(evaluateSnapshotDir(d2, FIXED_NOW).ok).toBe(false);
  });

  it("nenhum dump → DESCONHECIDO (sem PASS, sem FAIL)", () => {
    const root = freshRoot();
    const verdict = checkSnapshotFromRoot(root, FIXED_NOW);
    expect(verdict.status).toBe("DESCONHECIDO");
  });

  it("seleção pelo maior created_at entre trios válidos", () => {
    const root = freshRoot();
    writeTrio(root, "antigo", { ageH: 20 });
    writeTrio(root, "novo", { ageH: 2 });
    const verdict = checkSnapshotFromRoot(root, FIXED_NOW);
    expect(verdict.status).toBe("PASS");
    expect(verdict.detail).toContain("novo");
  });
});
