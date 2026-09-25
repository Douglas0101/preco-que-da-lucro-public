import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = resolve(root, "scripts/m02-debts-guard.mjs");

const tmp = mkdtempSync(join(tmpdir(), "debts-guard-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const HEADER = [
  "| id | origem | classe | severidade | closure test | evidência | status |",
  "| --- | --- | --- | --- | --- | --- | --- |",
].join("\n");

const ROW = "| DBT-01 | WP4 N1 | conformidade | alta | canario por store | selo WP4 | ABERTA |";

function fixture(name: string, content: string): string {
  const file = join(tmp, name);
  writeFileSync(file, content);
  return file;
}

function run(registry: string) {
  return spawnSync(process.execPath, [script, "--registry", registry], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function runDefault() {
  return spawnSync(process.execPath, [script], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
}

describe("guard do registry de dívidas (DEBTS.md)", () => {
  it("o caminho default ausente no snapshot falha fechado", () => {
    const result = runDefault();
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("registry ilegivel");
    expect(result.stdout).toBe("");
  });

  it("cabeçalho fora de ordem é reconhecido pelo header, não pela posição", () => {
    const reordered = [
      "| origem | id | classe | severidade | closure test | evidência | status |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      "| WP4 N1 | DBT-01 | conformidade | alta | canario por store | selo WP4 | ABERTA |",
    ].join("\n");
    const result = run(fixture("reordenado.md", `${reordered}\n`));
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("segunda tabela canônica no mesmo arquivo reprova", () => {
    const second =
      HEADER + "\n| DBT-02 | WP3 N2 | robustez | media | piso do runner | selo WP3 | ABERTA |";
    const result = run(fixture("duas-tabelas.md", `${HEADER}\n${ROW}\n\n${second}\n`));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("mais de uma tabela canonica");
  });

  it("id fora do padrão DBT-NN reprova", () => {
    const row = ROW.replace("DBT-01", "DBT-1");
    const result = run(fixture("id-padrao.md", `${HEADER}\n${row}\n`));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("fora do padrao DBT-NN");
  });

  it("linha com contagem de células divergente do header reprova", () => {
    const row = "| DBT-01 | WP4 N1 | conformidade | alta | canario por store | ABERTA |";
    const result = run(fixture("celulas.md", `${HEADER}\n${row}\n`));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("6 celulas");
  });

  it("severidade fora da taxonomia reprova", () => {
    const row = ROW.replace("| alta |", "| crítica |");
    const result = run(fixture("severidade.md", `${HEADER}\n${row}\n`));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("severidade fora da taxonomia");
  });

  it("status fora da taxonomia reprova", () => {
    const row = ROW.replace("ABERTA", "PRONTA");
    const result = run(fixture("status.md", `${HEADER}\n${row}\n`));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("status fora da taxonomia");
  });

  it("registry vazio reprova (0 = 0 não passa)", () => {
    const result = run(fixture("vazio.md", `# Registry\n\n${HEADER}\n`));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("registry vazio");
  });

  it("closure test ausente exige status NS (regra da casa)", () => {
    const semClosure = "| DBT-01 | WP4 N1 | conformidade | alta | — | selo WP4 | ABERTA |";
    const result = run(fixture("sem-closure.md", `${HEADER}\n${semClosure}\n`));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("status NS");
  });

  it("closure test ausente com status NS passa", () => {
    const semClosure = "| DBT-01 | WP4 N1 | conformidade | alta | N/A | selo WP4 | NS |";
    const result = run(fixture("sem-closure-ns.md", `${HEADER}\n${semClosure}\n`));
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("debts guard: OK");
  });

  it("closure presente com status NS reprova (a fronteira na outra direção)", () => {
    const row = "| DBT-01 | WP4 N1 | conformidade | alta | canario por store | selo WP4 | NS |";
    const result = run(fixture("closure-ns.md", `${HEADER}\n${row}\n`));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("closure test presente");
  });

  it("coluna obrigatória ausente reprova pelo nome", () => {
    const semEvidencia = [
      "| id | origem | classe | severidade | closure test | status |",
      "| --- | --- | --- | --- | --- | --- |",
      ROW.replace(" | selo WP4", ""),
    ].join("\n");
    const result = run(fixture("sem-coluna.md", `${semEvidencia}\n`));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("evidencia");
  });

  it("origem degenerada reprova", () => {
    const row = ROW.replace("WP4 N1", "N/A");
    const result = run(fixture("origem-degenerada.md", `${HEADER}\n${row}\n`));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("origem degenerada");
  });

  it("id duplicado reprova", () => {
    const result = run(fixture("duplicado.md", `${HEADER}\n${ROW}\n${ROW}\n`));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("duplicado");
  });

  it("classe fora da taxonomia reprova", () => {
    const row = ROW.replace("conformidade", "inventada");
    const result = run(fixture("classe.md", `${HEADER}\n${row}\n`));
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("classe");
  });

  it("registry ilegível sai com erro alto (exit 2)", () => {
    const result = run(join(tmp, "nao-existe.md"));
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("registry ilegivel");
  });
});
