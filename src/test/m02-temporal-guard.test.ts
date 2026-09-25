import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * Falsificação da guarda temporal (§6.2). O fixture é um repositório git REAL e autocontido: a
 * guarda resolve âncoras com `git`, então um diretório falso não exercitaria a invariante T2 — o
 * teste passaria por não ter o que medir. Cada caso escreve as três superfícies vivas e confere o
 * exit code E a mensagem nomeada.
 */
const root = resolve(import.meta.dirname, "../..");
const GUARDA = resolve(root, "scripts/m02-temporal-guard.mjs");
const fixtures: string[] = [];

function fixture({
  ancora,
  prazo,
  semSuperficie = false,
}: {
  ancora: string;
  prazo: string;
  semSuperficie?: boolean;
}) {
  const dir = mkdtempSync(join(tmpdir(), "temporal-"));
  fixtures.push(dir);
  mkdirSync(join(dir, "docs/evidence/agent-state/DECISIONS-PENDING"), { recursive: true });
  spawnSync("git", ["-C", dir, "init", "-q"], { encoding: "utf8" });
  spawnSync("git", ["-C", dir, "config", "user.email", "t@t"], { encoding: "utf8" });
  spawnSync("git", ["-C", dir, "config", "user.name", "t"], { encoding: "utf8" });
  writeFileSync(join(dir, "semente.txt"), "semente\n");
  spawnSync("git", ["-C", dir, "add", "-A"], { encoding: "utf8" });
  spawnSync("git", ["-C", dir, "commit", "-qm", "semente"], { encoding: "utf8" });
  if (semSuperficie) return dir;
  writeFileSync(
    join(dir, "docs/evidence/agent-state/PROGRESS.md"),
    `# PROGRESS\n\n## 1. Estado corrente\n\n- HEAD = \`${ancora}\` · o watcher caduca ${prazo}.\n\n## 2. Outra secao\n`,
  );
  writeFileSync(
    join(dir, "EXECUTION-STATE-PROGRAM.md"),
    `# Ledger\n\n### bloco antigo\n\n- nada\n\n### bloco vivo\n\n- HEAD = \`${ancora}\`\n`,
  );
  writeFileSync(
    join(dir, "docs/evidence/agent-state/DECISIONS-PENDING/REGISTRO-H.md"),
    `# REGISTRO-H\n\n| id | estado |\n| -- | ------ |\n| H-1 | aguardando |\n\n## Fechados\n\n| id | desfecho |\n| -- | -------- |\n| H-0 | \`${ancora}\` |\n`,
  );
  return dir;
}

function rodar(dir: string, asOf: string) {
  const r = spawnSync(process.execPath, [GUARDA, "--root", dir, "--as-of", asOf], {
    encoding: "utf8",
  });
  return { status: r.status, saida: `${r.stdout}${r.stderr}` };
}

function head(dir: string) {
  return spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim();
}

afterAll(() => {
  for (const dir of fixtures) rmSync(dir, { recursive: true, force: true });
});

describe("m02-temporal-guard — âncoras e prazos da superfície viva", () => {
  it("GREEN: âncora que resolve e prazo no futuro passam", () => {
    const dir = fixture({ ancora: "SEMENTE", prazo: "em 2099-01-01" });
    const sha = head(dir);
    writeFileSync(
      join(dir, "docs/evidence/agent-state/PROGRESS.md"),
      `# PROGRESS\n\n## 1. Estado corrente\n\n- HEAD = \`${sha}\` · o watcher caduca em 2099-01-01.\n\n## 2. Outra secao\n`,
    );
    const { status, saida } = rodar(dir, "2026-09-21");
    expect(status).toBe(0);
    expect(saida).toContain("m02-temporal-guard: OK (3 superficies vivas, 0 violacao)");
  });

  it("RED T2: âncora que NÃO resolve reprova, nomeando o token e a linha", () => {
    const dir = fixture({ ancora: "deadbee", prazo: "em 2099-01-01" });
    const { status, saida } = rodar(dir, "2026-09-21");
    expect(status).toBe(1);
    expect(saida).toContain("T2 âncora não resolve: `deadbee`");
    expect(saida).toContain("linha 3");
  });

  it("RED T1: prazo VENCIDO reprova, mesmo com todas as âncoras válidas", () => {
    const dir = fixture({ ancora: "SEMENTE", prazo: "em 2020-01-01" });
    const sha = head(dir);
    writeFileSync(
      join(dir, "docs/evidence/agent-state/PROGRESS.md"),
      `# PROGRESS\n\n## 1. Estado corrente\n\n- HEAD = \`${sha}\` · o watcher caduca em 2020-01-01.\n\n## 2. Outra secao\n`,
    );
    const { status, saida } = rodar(dir, "2026-09-21");
    expect(status).toBe(1);
    expect(saida).toContain("T1 prazo vencido em 2020-01-01");
  });

  it("o journal append-only fica FORA: prazo vencido fora do §1 não reprova", () => {
    const dir = fixture({ ancora: "SEMENTE", prazo: "em 2099-01-01" });
    const sha = head(dir);
    writeFileSync(
      join(dir, "docs/evidence/agent-state/PROGRESS.md"),
      `# PROGRESS\n\n## 1. Estado corrente\n\n- HEAD = \`${sha}\` · caduca em 2099-01-01.\n\n## 2. Journal\n\n| L1 | ✔ | o watcher caducou em 2020-01-01 e isso é história |\n`,
    );
    const { status, saida } = rodar(dir, "2026-09-21");
    expect(status).toBe(0);
    expect(saida).toContain("m02-temporal-guard: OK (3 superficies vivas, 0 violacao)");
  });

  it("PRECONDICAO: superfície ausente sai com exit 2 (não com 1)", () => {
    const dir = fixture({ ancora: "SEMENTE", prazo: "em 2099-01-01", semSuperficie: true });
    const { status, saida } = rodar(dir, "2026-09-21");
    expect(status).toBe(2);
    expect(saida).toContain("precondicao: superficie viva ausente");
  });

  it("PRECONDICAO: diretório sem git sai com exit 2", () => {
    const dir = mkdtempSync(join(tmpdir(), "temporal-nogit-"));
    fixtures.push(dir);
    const { status, saida } = rodar(dir, "2026-09-21");
    expect(status).toBe(2);
    expect(saida).toContain("nao e um repositorio git");
  });

  it("a superfície de evidência ausente no snapshot falha fechada", () => {
    const r = spawnSync(process.execPath, [GUARDA], { cwd: root, encoding: "utf8" });
    const output = `${r.stdout}${r.stderr}`;
    expect(r.status).toBe(2);
    expect(output).toMatch(/superficie viva ausente|clone raso/);
  });
});

describe("m02-temporal-guard — endurecimentos do S6 do WP-R7", () => {
  const asOf = new Date("2026-09-21T10:00:00Z");
  const prazos = (linha: string) => {
    const r = spawnSync(
      process.execPath,
      [
        "-e",
        `
      import(${JSON.stringify(`file://${root}/scripts/m02-temporal-guard.mjs`)}).then(({auditarPrazos}) => {
        const f = auditarPrazos(${JSON.stringify(linha)}, new Date("2026-09-21T10:00:00Z"));
        process.stdout.write(f.length === 0 ? "passa" : "REPROVA");
      });`,
      ],
      { encoding: "utf8" },
    );
    return r.stdout.trim();
  };

  it("N1: errata e prazo vivo na MESMA linha — a data viva continua vigiada", () => {
    expect(
      prazos(
        "Prazo: caduca em 2026-09-26T15:31Z — o prazo anterior de 2026-09-21T03:37Z referia-se ao arme de 2026-09-14 e esta desatualizado.",
      ),
    ).toBe("passa");
    expect(prazos("Detector caduca em 2020-01-01.")).toBe("REPROVA");
  });

  it("N1b: `vence` dentro de `convence` não é marcador (fronteira de palavra)", () => {
    expect(prazos("A medicao convence: o numero de 2020-01-01 nao mudou.")).toBe("passa");
  });

  it("N6/B2: data inválida (rollover) reprova em vez de rolar para o futuro", () => {
    expect(prazos("Detector caduca em 2026-13-45.")).toBe("REPROVA");
    expect(prazos("Detector caduca em 2026-02-30.")).toBe("REPROVA");
  });

  it("B3: data sem zero à esquerda é detectada", () => {
    expect(prazos("Detector caduca em 2026-9-1.")).toBe("REPROVA");
  });

  it("B7: a SEGUNDA ocorrência de prazo na mesma linha também é vigiada", () => {
    expect(prazos("O prazo do contrato segue. " + "y".repeat(140) + " Caduca em 2020-01-01.")).toBe(
      "REPROVA",
    );
  });

  it("N3: id de run todo-decimal não é âncora; hex com letra é", () => {
    const dir = fixture({ ancora: "SEMENTE", prazo: "em 2099-01-01" });
    const sha = head(dir);
    const escrever = (token: string) => {
      writeFileSync(
        join(dir, "docs/evidence/agent-state/PROGRESS.md"),
        `# PROGRESS\n\n## 1. Estado corrente\n\n- run \`${token}\` · caduca em 2099-01-01.\n\n## 2. Fim\n`,
      );
      return rodar(dir, "2026-09-21");
    };
    expect(escrever("35559344008").status).toBe(0);
    expect(escrever("deadbee").status).toBe(1);
    expect(escrever(sha).status).toBe(0);
  });

  it("N2: o par `sha@run` é vigiado pelo sha, e o run sozinho não é âncora", () => {
    const dir = fixture({ ancora: "SEMENTE", prazo: "em 2099-01-01" });
    const sha = head(dir);
    const escrever = (token: string) => {
      writeFileSync(
        join(dir, "docs/evidence/agent-state/PROGRESS.md"),
        `# PROGRESS\n\n## 1. Estado corrente\n\n- ${token} · caduca em 2099-01-01.\n\n## 2. Fim\n`,
      );
      return rodar(dir, "2026-09-21");
    };
    expect(escrever(`\`${sha}@35559344008\``).status).toBe(0);
    expect(escrever("`deadbee@35559344008`").status).toBe(1);
  });

  it("C2: âncora em MAIÚSCULAS é auditada (hex é case-insensitive)", () => {
    const dir = fixture({ ancora: "SEMENTE", prazo: "em 2099-01-01" });
    writeFileSync(
      join(dir, "docs/evidence/agent-state/PROGRESS.md"),
      "# PROGRESS\n\n## 1. Estado corrente\n\n- commit `DEADBEE` · caduca em 2099-01-01.\n\n## 2. Fim\n",
    );
    expect(rodar(dir, "2026-09-21").status).toBe(1);
  });

  it("N7: sem o cabeçalho de fronteira o recorte é PRECONDIÇÃO, não arquivo inteiro", () => {
    const dir = fixture({ ancora: "SEMENTE", prazo: "em 2099-01-01" });
    writeFileSync(
      join(dir, "docs/evidence/agent-state/DECISIONS-PENDING/REGISTRO-H.md"),
      "# REGISTRO-H\n\n| id | estado |\n| -- | ------ |\n| H-1 | aguardando |\n\n## Encerrados\n\n| id | desfecho |\n| -- | -------- |\n| H-0 | caducou em 2020-01-01 |\n",
    );
    const { status, saida } = rodar(dir, "2026-09-21");
    // a fronteira ausente degradaria o recorte para o arquivo inteiro (e a guarda passaria a
    // reprovar história); o que importa é a CLASSE — precondição, exit 2 — e não o texto exato
    expect(status).toBe(2);
    expect(saida).toContain("precondicao");
  });
});
