import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

/**
 * Casos negativos da allowlist do `range-secret-scan` (Item 5, escopo A).
 *
 * A regra que este arquivo protege: **reduzir ruido sem reduzir deteccao**. Toda supressao e
 * declarada em `scripts/local-ci-secret-allowlist.json` (padrao literal + escopo de arquivo +
 * motivo + data + autor) e todo padrao real continua reprovando.
 *
 * O modulo e executado como processo real (nao ha copia da logica no teste): o que se mede e o
 * comportamento do instrumento que roda no pipeline.
 */

const ROOT = process.cwd();
const MODULE = join(ROOT, "scripts/local-ci-secret-scan.mjs");
const ALLOWLIST = join(ROOT, "scripts/local-ci-secret-allowlist.json");

const tmp: string[] = [];
afterEach(() => tmp.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

/** Monta uma entrada no formato do `git grep -nIE` e roda o classificador. */
function classify(records: string[], allowlistPath = ALLOWLIST) {
  const result = spawnSync("node", [MODULE], {
    cwd: ROOT,
    encoding: "utf8",
    input: records.join("\n"),
    env: { ...process.env, LOCAL_CI_SECRET_ALLOWLIST: allowlistPath },
  });
  return {
    status: result.status,
    hits: (result.stdout ?? "").split("\n").filter(Boolean),
    summary: result.stderr ?? "",
  };
}

const REV = "0".repeat(40);
const rec = (path: string, content: string, line = 1) => `${REV}:${path}:${line}:${content}`;
const fake = (prefix: string, n: number, fill = "A") => `${prefix}${fill.repeat(n)}`;
// Literais montados em runtime: um fixture que contenha o padrao por extenso faz o PROPRIO scan (e o
// `m02:secrets-audit`) reprovar este arquivo — o instrumento nao pode carregar o que ele procura.
const pad = (n: number, ch: string) => ch.repeat(n);
const pemHeader = `-----BEGIN ${"RSA "}PRIVATE KEY-----`;
const pgUrl = (port: number) => `postgresql${"://"}postgres:postgres${"@"}127.0.0.1:${port}/db`;
const hostPlaceholder = `postgresql${"://"}app:x${"@"}<host>/db`;

describe("Item 5A · allowlist do range-secret-scan", () => {
  it("N1 — ghp_ falso continua sendo HIT", () => {
    const { status, hits } = classify([rec("src/leak.ts", `const k = "${fake("ghp_", 40)}";`)]);
    expect(status).toBe(0);
    expect(hits).toEqual(["src/leak.ts:1"]);
  });

  it("N2 — BEGIN PRIVATE KEY falso continua sendo HIT", () => {
    const { hits } = classify([rec("config/key.pem", pemHeader)]);
    expect(hits).toEqual(["config/key.pem:1"]);
  });

  it("N3 — AKIA falso continua sendo HIT", () => {
    const { hits } = classify([rec("src/aws.ts", `key = "${fake("AKIA", 16, "Q")}"`)]);
    expect(hits).toEqual(["src/aws.ts:1"]);
  });

  it("N4 — xox falso continua sendo HIT", () => {
    const { hits } = classify([rec("src/slack.ts", `token = "${fake(`xox${"b-"}`, 24, "1")}"`)]);
    expect(hits).toEqual(["src/slack.ts:1"]);
  });

  it("N5 — credencial loopback DENTRO do escopo declarado nao e hit", () => {
    const { hits, summary } = classify([
      rec("scripts/local-ci.sh", `DATABASE_URL="${pgUrl(55432)}"`),
    ]);
    expect(hits).toEqual([]);
    expect(summary).toContain("permitidos=1");
    expect(summary).toContain("AL-01:1");
  });

  it("N6 — a MESMA credencial FORA do escopo declarado e hit", () => {
    const { hits, summary } = classify([rec("src/qualquer.ts", `const u = "${pgUrl(5432)}"`)]);
    expect(hits).toEqual(["src/qualquer.ts:1"]);
    expect(summary).toContain("permitidos=0");
  });

  it("N7 — <host> permitido apenas no arquivo declarado", () => {
    const inside = classify([rec("EXECUTION-STATE-PROGRAM.md", `payload \`${hostPlaceholder}\``)]);
    expect(inside.hits).toEqual([]);
    const outside = classify([rec("src/outro.ts", `const u = "${hostPlaceholder}"`)]);
    expect(outside.hits).toEqual(["src/outro.ts:1"]);
  });

  it("N8 — padrao duro vence a allowlist na MESMA linha (sem fail-open)", () => {
    // Linha com a credencial permitida E um token real: a supressao nao pode engolir o token.
    const { hits } = classify([
      rec("scripts/local-ci.sh", `DATABASE_URL="${pgUrl(5432)}" TOKEN="${fake("ghp_", 40)}"`),
    ]);
    expect(hits).toEqual(["scripts/local-ci.sh:1"]);
  });

  it("N9 — allowlist com campo obrigatorio ausente e PRECONDICAO (exit 2), nunca 'nada encontrado'", () => {
    const dir = mkdtempSync(join(tmpdir(), "item5-allow-"));
    tmp.push(dir);
    const broken = join(dir, "broken.json");
    writeFileSync(
      broken,
      JSON.stringify({
        schema: "local-ci/secret-allowlist/v1",
        entries: [{ id: "AL-99", pattern: "x", scope: "y" }], // sem reason/decidedAt/decidedBy
      }),
    );
    const { status, summary } = classify([rec("src/a.ts", "nada")], broken);
    expect(status).toBe(2);
    expect(summary).toContain("precondicao");
  });

  it("N11 — padrao DURO dentro do arquivo de autodeclaracao continua sendo HIT", () => {
    // A isencao do arquivo que declara a allowlist vale para a supressao, NAO para os padroes duros.
    const { hits } = classify([
      rec("scripts/local-ci-secret-allowlist.json", `{"x": "${fake("ghp_", 40)}"}`),
    ]);
    expect(hits).toEqual(["scripts/local-ci-secret-allowlist.json:1"]);
  });

  it("N12 — o arquivo de autodeclaracao nao e hit pelo proprio padrao que declara", () => {
    const { hits, summary } = classify([
      rec(
        "scripts/local-ci-secret-allowlist.json",
        `"pattern": "${pgUrl(5432).replace("/db", "")}"`,
      ),
    ]);
    expect(hits).toEqual([]);
    expect(summary).toContain("autodeclarados=1");
  });

  it("N10 — a allowlist declarada e minima e todo padrao real permanece coberto", () => {
    const allowlist = JSON.parse(readFileSync(ALLOWLIST, "utf8")) as {
      entries: Array<{
        id: string;
        pattern: string;
        scope: string;
        reason: string;
        decidedAt: string;
        decidedBy: string;
      }>;
    };
    // Toda entrada tem os cinco campos exigidos e escopo NAO global.
    for (const entry of allowlist.entries) {
      expect(entry.reason.length).toBeGreaterThan(30);
      expect(entry.decidedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(entry.decidedBy.length).toBeGreaterThan(3);
      expect(entry.scope).not.toBe("*");
      expect(entry.scope.endsWith("/") || entry.scope.includes(".")).toBe(true);
    }
    // Nenhum padrao real pode estar na allowlist.
    for (const forbidden of ["ghp_", "gho_", "xox", "PRIVATE KEY", "AKIA", "sk-proj-", "eyJ"])
      for (const entry of allowlist.entries) expect(entry.pattern).not.toContain(forbidden);
  });
});
