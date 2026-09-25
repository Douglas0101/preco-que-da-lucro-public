import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditSecrets } from "../../scripts/m02-secrets-audit";

/**
 * Closure test de DBT-19 — falsificabilidade das duas guardas que o registry declara
 * contrato e que hoje não rodam em gate nenhum (`m02:boundaries`) ou rodam só na light
 * (`m02:secrets-audit`).
 *
 * Regra que este arquivo serve: **nenhum gate pode ser encadeado antes de provar que sabe
 * reprovar**. Ele NÃO altera gate nenhum — é a prova que precede o encadeamento.
 *
 * Isolamento: `m02:boundaries` não aceita raiz/fixture (caminhos fixos em
 * `scripts/m02-boundaries.ts:55-56`), então a prova o executa sobre uma **cópia** da árvore
 * mínima em `mkdtemp` — o repositório real **nunca** é mutado (o plano original previa mutar
 * `matrix.yaml` e restaurar por sha256; a cópia isolada elimina esse risco).
 */

const ROOT = process.cwd();
const TSX = join(ROOT, "node_modules/.bin/tsx");
const MATRIX = join(ROOT, "docs/specs/M-02/matrix.yaml");

const fixtures: string[] = [];
afterEach(() => fixtures.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

function runGuard(script: string, cwd: string) {
  const result = spawnSync(TSX, [script], { cwd, encoding: "utf8" });
  const stdout = result.stdout ?? "";
  const stderr = result.stderr ?? "";
  // stdout e stderr separados de proposito: o CLI imprime o relatorio JSON em stdout e o
  // diagnostico legivel (arquivo:linha, sem valor) em stderr — concatenar quebraria o JSON.parse.
  return { status: result.status, stdout, stderr, out: `${stdout}${stderr}` };
}

/** Cópia mínima: o guard lê apenas a matriz e usa `existsSync` nos caminhos de catálogo. */
function boundaryFixture(): { dir: string; matrixPath: string } {
  const dir = mkdtempSync(join(tmpdir(), "dbt19-boundary-"));
  fixtures.push(dir);
  mkdirSync(join(dir, "scripts"), { recursive: true });
  mkdirSync(join(dir, "docs/specs/M-02"), { recursive: true });
  writeFileSync(
    join(dir, "scripts/m02-boundaries.ts"),
    readFileSync(join(ROOT, "scripts/m02-boundaries.ts")),
  );
  const matrixPath = join(dir, "docs/specs/M-02/matrix.yaml");
  writeFileSync(matrixPath, readFileSync(MATRIX));

  const matrix = JSON.parse(readFileSync(MATRIX, "utf8")) as {
    policy: {
      catalog: {
        services: Record<string, { path: string; status: string }>;
        repositories: Record<string, { path: string; status: string }>;
      };
    };
  };
  for (const entry of Object.values({
    ...matrix.policy.catalog.services,
    ...matrix.policy.catalog.repositories,
  })) {
    if (entry.status === "contract-only") continue;
    const target = join(dir, entry.path);
    mkdirSync(dirname(target), { recursive: true });
    if (!readFileSync) continue;
    writeFileSync(target, "");
  }
  return { dir, matrixPath };
}

describe("DBT-19 · falsificabilidade das guardas", () => {
  it("T1 — m02:boundaries fica VERDE na árvore real (sem falso positivo)", () => {
    const { status, out } = runGuard(join(ROOT, "scripts/m02-boundaries.ts"), ROOT);
    expect(out).toContain("boundary is clean");
    expect(status).toBe(0);
  });

  it("T2 — m02:boundaries REPROVA quando uma boundary é violada (fixture isolado)", () => {
    const { dir, matrixPath } = boundaryFixture();
    // Controle positivo ANTES da mutação: prova que o RED abaixo vem da violação, não do fixture.
    expect(runGuard(join(dir, "scripts/m02-boundaries.ts"), dir).status).toBe(0);

    const matrix = JSON.parse(readFileSync(matrixPath, "utf8")) as {
      bffs: Array<{ path: string; databasePaths: string[] }>;
    };
    matrix.bffs[0].databasePaths.push("src/not-allowlisted/evil.server.ts");
    writeFileSync(matrixPath, JSON.stringify(matrix, null, 2));

    const { status, out } = runGuard(join(dir, "scripts/m02-boundaries.ts"), dir);
    expect(status).toBe(1);
    expect(out).toContain("src/not-allowlisted/evil.server.ts");
  });

  it("T4 — m02:boundaries devolve exit 2 de PRECONDIÇÃO com a matriz ausente", () => {
    const { dir, matrixPath } = boundaryFixture();
    rmSync(matrixPath);
    const { status, out } = runGuard(join(dir, "scripts/m02-boundaries.ts"), dir);
    // Distinto do `1` de violação (T2): precondição não pode ser confundida com boundary violada.
    expect(status).toBe(2);
    expect(out).toContain("precondition failed");
  });

  it("T5 — m02:secrets-audit DETECTA literal de segredo sem vazar o valor", () => {
    const dir = mkdtempSync(join(tmpdir(), "dbt19-audit-"));
    fixtures.push(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    // Montado em runtime: o literal completo nunca aparece neste arquivo versionado.
    const fake = `ghp_${"A".repeat(40)}`;
    writeFileSync(join(dir, "src/leak.ts"), `const k = "${fake}";\n`);

    const report = auditSecrets(dir);
    expect(report.possible_secret_literals).toHaveLength(1);
    expect(report.possible_secret_literals[0].path).toBe("src/leak.ts");
    expect(JSON.stringify(report)).not.toContain(fake);
  });

  it("T6 — o CLI do secrets-audit REPROVA na presença do literal (exit 1)", () => {
    // Tripwire invertido: até 2026-09-23 o exit code ignorava `possible_secret_literals`
    // (`failures.length ? 2 : 0`) e este caso assertava `0`. A correção aprovada no ciclo
    // SDD-20260923 (ADR-030 §9) fez o veredicto considerar o literal; a asserção foi invertida
    // conforme a instrução que o próprio caso carregava.
    const dir = mkdtempSync(join(tmpdir(), "dbt19-audit-cli-"));
    fixtures.push(dir);
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "scripts/m02-secrets-audit.ts"),
      readFileSync(join(ROOT, "scripts/m02-secrets-audit.ts")),
    );
    writeFileSync(join(dir, "src/leak.ts"), `const k = "ghp_${"A".repeat(40)}";\n`);

    const { status, stdout, stderr } = runGuard(join(dir, "scripts/m02-secrets-audit.ts"), dir);
    expect(JSON.parse(stdout).possible_secret_literals).toHaveLength(1);
    expect(status).toBe(1);
    // Legível sem vazar valor: nomeia arquivo:linha em stderr.
    expect(stderr).toContain("possible secret literal at src/leak.ts:1");
    expect(stderr).not.toContain(`ghp_${"A".repeat(40)}`);
  });

  it("T7 — o CLI do secrets-audit devolve exit 2 de PRECONDIÇÃO com cobertura incompleta", () => {
    // `2` (precondição) tem de continuar distinto de `1` (violação): cobertura incompleta não é
    // achado de segredo, é impossibilidade de auditar.
    const dir = mkdtempSync(join(tmpdir(), "dbt19-audit-pre-"));
    fixtures.push(dir);
    mkdirSync(join(dir, "scripts"), { recursive: true });
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "scripts/m02-secrets-audit.ts"),
      readFileSync(join(ROOT, "scripts/m02-secrets-audit.ts")),
    );
    writeFileSync(join(dir, "src/oversize.ts"), "a".repeat(1024 * 1024 + 1));

    expect(runGuard(join(dir, "scripts/m02-secrets-audit.ts"), dir).status).toBe(2);
  });
});
