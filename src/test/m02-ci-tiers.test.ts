import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * WP-R8 — os tiers de CI, falsificados contra o YAML REAL.
 *
 * O teste não reimplementa a lógica de escopo: ele **extrai o script do próprio
 * `ui-stack.yml`**, substitui as expressões `${{ github.* }}` pelos valores do cenário, executa com
 * `bash` e lê o `$GITHUB_OUTPUT`. Assim o artefato medido é o que a CI vai rodar, não uma cópia que
 * pode divergir dele — que é a classe de falha que este programa persegue desde o WP-R2.
 *
 * Dois defeitos encontrados na auditoria do WP-R8 e fixados aqui:
 *   A1 `if: steps.scope.outputs.db == 'true'` pulava o tier de banco com output VAZIO (fail-open
 *      pela porta dos outputs) — a polaridade fail-closed é `!= 'false'`.
 *   A2 o ramo de base desconhecida dizia "rodando TODOS os tiers" e emitia só `db`: force-push,
 *      primeira push de branch e `workflow_dispatch` caiam em chromium-only.
 */
const root = resolve(import.meta.dirname, "../..");
const YAML = readFileSync(resolve(root, ".github/workflows/ui-stack.yml"), "utf8");
const temporarios: string[] = [];

afterAll(() => {
  for (const d of temporarios) rmSync(d, { recursive: true, force: true });
});

/** Extrai o bloco `run: |` do step com o `id` dado, ja dedentado. */
function scriptDoStep(id: string): string {
  const linhas = YAML.split("\n");
  const inicio = linhas.findIndex((l) => l.trim() === `- id: ${id}`);
  expect(inicio).toBeGreaterThan(-1);
  const runIdx = linhas.findIndex((l, k) => k > inicio && /^\s*run: \|\s*$/.test(l));
  expect(runIdx).toBeGreaterThan(inicio);
  const indent = linhas[runIdx].search(/\S/);
  const corpo: string[] = [];
  for (let k = runIdx + 1; k < linhas.length; k += 1) {
    const l = linhas[k];
    if (l.trim() === "") {
      corpo.push("");
      continue;
    }
    if (l.search(/\S/) <= indent) break;
    corpo.push(l.slice(indent + 2));
  }
  return corpo.join("\n");
}

function repoDeTeste(): { dir: string; base: string } {
  const dir = mkdtempSync(join(tmpdir(), "ci-tier-"));
  temporarios.push(dir);
  const git = (args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
  git(["init", "-q"]);
  git(["config", "user.email", "t@t"]);
  git(["config", "user.name", "t"]);
  writeFileSync(join(dir, "README.md"), "s\n");
  git(["add", "-A"]);
  git(["commit", "-qm", "base"]);
  const base = git(["rev-parse", "HEAD"]).stdout.trim();
  return { dir, base };
}

function rodarEscopo(cenario: {
  dir: string;
  base: string;
  evento: string;
  before: string;
  head?: string;
}): Record<string, string> {
  // O repo VEM DO CENARIO: criar um repo proprio aqui produzia SHAs de outro repositorio e o
  // `git diff` morria com "bad object" — o teste media o nada e acusava a coisa errada.
  const { dir, base } = cenario;
  const fonte = scriptDoStep("scope")
    .replace(/\$\{\{\s*github\.event_name\s*\}\}/g, cenario.evento)
    .replace(/\$\{\{\s*github\.event\.pull_request\.base\.sha\s*\}\}/g, cenario.base ?? base)
    .replace(/\$\{\{\s*github\.event\.before\s*\}\}/g, cenario.before)
    .replace(/\$\{\{\s*github\.sha\s*\}\}/g, cenario.head ?? base);
  writeFileSync(join(dir, "escopo.sh"), fonte);
  const saida = join(dir, "github-output");
  writeFileSync(saida, "");
  const r = spawnSync("bash", [join(dir, "escopo.sh")], {
    cwd: dir,
    encoding: "utf8",
    env: { ...process.env, GITHUB_OUTPUT: saida },
  });
  const out: Record<string, string> = {
    __stdout: `${r.stdout}${r.stderr}`,
    __status: String(r.status),
  };
  for (const l of readFileSync(saida, "utf8").split("\n")) {
    const m = /^([a-z]+)=(.*)$/.exec(l);
    if (m) out[m[1]] = m[2];
  }
  return out;
}

function comCommitDe(dir: string, arquivo: string, base: string): string {
  mkdirSync(join(dir, ...arquivo.split("/").slice(0, -1)), { recursive: true });
  writeFileSync(join(dir, arquivo), "x\n");
  spawnSync("git", ["-C", dir, "add", "-A"], { encoding: "utf8" });
  spawnSync("git", ["-C", dir, "commit", "-qm", "mudanca"], { encoding: "utf8" });
  return (
    spawnSync("git", ["-C", dir, "rev-parse", "HEAD"], { encoding: "utf8" }).stdout.trim() || base
  );
}

describe("WP-R8 — polaridade fail-closed das condições de tier", () => {
  it("A1: nenhuma condição de gate usa `== 'true'` (output vazio pularia o tier)", () => {
    const gates = [...YAML.matchAll(/if: steps\.scope\.outputs\.(\w+) == 'true'/g)];
    expect(gates.map((m) => m[1])).toEqual([]);
  });

  it("A1: os tiers de banco usam `!= 'false'` e o aviso de pulo usa `== 'false'`", () => {
    expect([...YAML.matchAll(/if: steps\.scope\.outputs\.db != 'false'/g)].length).toBe(2);
    expect([...YAML.matchAll(/if: steps\.scope\.outputs\.db == 'false'/g)].length).toBe(1);
  });

  it("A2b: o `if` shell dos browsers só cai em chromium com `false` explícito", () => {
    const sh = scriptDoStep("browsers");
    expect(sh).toContain('= "false" ]');
    expect(sh).not.toContain('= "true" ]');
    const ramoIf = sh.slice(sh.indexOf('= "false" ]'), sh.indexOf("else"));
    const ramoElse = sh.slice(sh.indexOf("else"));
    expect(ramoIf).toContain('lista="chromium"');
    // a asserção é sobre o que ALIMENTA o runner, não sobre a prosa do aviso
    expect(ramoIf).toContain('projetos="--project=chromium --project=mobile"');
    expect(ramoElse).toContain("chromium firefox webkit");
  });

  it("N6: o aviso dos browsers é derivado do que foi escolhido, não prosa fixa", () => {
    const sh = scriptDoStep("browsers");
    // o dado tem de ser impresso a partir das MESMAS variáveis que alimentam o GITHUB_OUTPUT
    expect(sh).toContain('echo "navegadores escolhidos: ${lista} | projetos: ${projetos}"');
    expect([...sh.matchAll(/lista="[^"]*"/g)].length).toBe(2);
  });
});

describe("WP-R8 — o script de escopo real, executado", () => {
  it("push com diff comum: db=false e crossbrowser=false (explícitos, não vazios)", () => {
    const { dir, base } = repoDeTeste();
    const head = comCommitDe(dir, "src/test/qualquer.test.ts", base);
    const out = rodarEscopo({ dir, base, evento: "push", before: base, head });
    expect(out.__status).toBe("0");
    expect(out.__stdout).toContain("arquivos alterados:");
    expect(out.db).toBe("false");
    expect(out.crossbrowser).toBe("false");
  });

  it("push com diff de banco: db=true", () => {
    const { dir, base } = repoDeTeste();
    const head = comCommitDe(dir, "drizzle/9999_x.sql", base);
    const out = rodarEscopo({ dir, base, evento: "push", before: base, head });
    expect(out.db).toBe("true");
  });

  it("A2: base desconhecida (force-push / primeira push) roda TODOS os tiers — inclusive cross-browser", () => {
    const { dir, base } = repoDeTeste();
    const out = rodarEscopo({
      dir,
      base,
      evento: "push",
      before: "0000000000000000000000000000000000000000",
    });
    expect(out.db).toBe("true");
    expect(out.crossbrowser).toBe("true");
    expect(out.motivo).toBe("base-desconhecida");
  });

  it("A2: `workflow_dispatch` roda TODOS os tiers — inclusive cross-browser", () => {
    const { dir, base } = repoDeTeste();
    const out = rodarEscopo({ dir, base, evento: "workflow_dispatch", before: "" });
    expect(out.db).toBe("true");
    expect(out.crossbrowser).toBe("true");
  });

  it("A2/4.2: base existente mas NÃO-ANCESTRAL (força-push / história reescrita) roda TODOS os tiers", () => {
    // Porta-b da base desconhecida: `before` EXISTE no repositório (cat-file OK) mas não é ancestral
    // do head — quem decide é o disjuntor `merge-base --is-ancestor`, não a existência. Sem este
    // caso, só a porta-a (SHA todo-zeros) estaria executada; as duas portas alimentam o D1.
    const { dir, base } = repoDeTeste();
    const git = (args: string[]) => spawnSync("git", ["-C", dir, ...args], { encoding: "utf8" });
    git(["checkout", "-q", "-b", "historia-reescrita"]);
    writeFileSync(join(dir, "README.md"), "ramo paralelo\n");
    git(["add", "-A"]);
    git(["commit", "-qm", "ramo paralelo"]);
    const irmao = git(["rev-parse", "HEAD"]).stdout.trim();
    expect(irmao).toMatch(/^[0-9a-f]{40}$/);
    git(["checkout", "-q", "-"]);
    const head = comCommitDe(dir, "src/lib/y.ts", base);
    const out = rodarEscopo({ dir, base, evento: "push", before: irmao, head });
    expect(out.__status).toBe("0");
    expect(out.db).toBe("true");
    expect(out.crossbrowser).toBe("true");
    expect(out.motivo).toBe("base-desconhecida");
  });

  it("pull_request usa a base do PR e roda cross-browser", () => {
    const { dir, base } = repoDeTeste();
    const head = comCommitDe(dir, "src/lib/x.ts", base);
    const out = rodarEscopo({ dir, base, evento: "pull_request", before: "", head });
    expect(out.db).toBe("false");
    expect(out.crossbrowser).toBe("true");
  });

  it("sem repositório git o passo cai no ramo fail-closed (roda tudo), não em `pula`", () => {
    const dir = mkdtempSync(join(tmpdir(), "ci-tier-nogit-"));
    temporarios.push(dir);
    const fonte = scriptDoStep("scope")
      .replace(/\$\{\{\s*github\.event_name\s*\}\}/g, "push")
      .replace(/\$\{\{\s*github\.event\.before\s*\}\}/g, "abc1234")
      .replace(/\$\{\{\s*github\.sha\s*\}\}/g, "abc1234");
    writeFileSync(join(dir, "escopo.sh"), fonte);
    writeFileSync(join(dir, "github-output"), "");
    const r = spawnSync("bash", [join(dir, "escopo.sh")], {
      cwd: dir,
      encoding: "utf8",
      env: { ...process.env, GITHUB_OUTPUT: join(dir, "github-output") },
    });
    // sem repositório, `git cat-file` falha -> cai no ramo fail-closed (roda tudo), nunca em "pula"
    expect(r.status).toBe(0);
    expect(readFileSync(join(dir, "github-output"), "utf8")).toContain("crossbrowser=true");
  });
});

describe("WP-R8 — guardas semânticas (o S6 mostrou que literais não bastam)", () => {
  it("N4a: o e2e consome a DECISÃO do passo de browsers, não uma lista literal", () => {
    const passos = YAML.split("\n");
    const cmd = passos.filter((l) => /npx playwright test/.test(l)).join("\n");
    expect(cmd).toContain("steps.browsers.outputs.projetos");
  });

  it("N4b: os tiers de banco são decididos por `db`, e o passo de escopo vem ANTES deles", () => {
    const linhas = YAML.split("\n");
    const iScope = linhas.findIndex((l) => l.trim() === "- id: scope");
    const iDb = linhas.findIndex((l) => /run: npm run db:test/.test(l));
    const iNotice = linhas.findIndex((l) => /db tiers skipped/.test(l));
    expect(iScope).toBeGreaterThan(-1);
    expect(iDb).toBeGreaterThan(iScope);
    expect(iNotice).toBeGreaterThan(iDb);
    // o aviso é a negação EXATA do gate — sem isso, tier e aviso podem divergir em silêncio.
    // A busca sobe até o `if:` do passo (pode haver comentário entre o `if:` e o `run:`).
    const ifAcima = (i: number) => {
      for (let k = i; k > Math.max(0, i - 6); k -= 1)
        if (/^\s*- if:/.test(linhas[k])) return linhas[k];
      return "";
    };
    expect(ifAcima(iDb)).toContain("steps.scope.outputs.db != 'false'");
    expect(ifAcima(iNotice)).toContain("steps.scope.outputs.db == 'false'");
  });

  it("N4c: o grupo de concurrency é por ref (sem isso `develop` cancelaria `main`)", () => {
    expect(YAML).toMatch(/group: \$\{\{ github\.workflow \}\}-\$\{\{ github\.ref \}\}/);
  });

  it("N4d: nenhuma expressão `${{ }}` desconhecida sobra no script de escopo", () => {
    const conhecidas = [
      "github.event_name",
      "github.event.pull_request.base.sha",
      "github.event.before",
      "github.sha",
    ];
    const doScript = [...scriptDoStep("scope").matchAll(/\$\{\{\s*([^}]+?)\s*\}\}/g)].map(
      (m) => m[1],
    );
    expect(doScript.filter((e) => !conhecidas.includes(e))).toEqual([]);
    // e a lista de conhecidas tem de cobrir TODAS as expressões do script (nada fica sem substituição)
    expect(new Set(doScript).size).toBeGreaterThan(0);
  });

  it("N1: a base não-ancestral é fail-closed (ancestralidade, não só existência)", () => {
    const sh = scriptDoStep("scope");
    expect(sh).toContain('git merge-base --is-ancestor "$base" "$head"');
  });

  // N5: o aviso tem de ser a negação ESTRUTURAL do gate, não uma string parecida. Se alguém
  // estreitar o gate (acrescentar condição, trocar o output) sem mexer no aviso, o aviso passa a
  // mentir — e um aviso que mente é pior que aviso nenhum. A igualdade é derivada, não literal.
  it("N5: para cada output de escopo, o aviso é a negação exata do gate que decide o tier", () => {
    const passos = new Map<string, { cond: string; corpo: string[] }>();
    const linhas = YAML.split("\n");
    let atual: string | null = null;
    for (const l of linhas) {
      if (/^ {6}- /.test(l)) {
        atual = l;
        passos.set(atual, { cond: "", corpo: [] });
      }
      if (atual === null) continue;
      const p = passos.get(atual)!;
      if (/^\s*- if:/.test(l)) p.cond = l.replace(/^\s*- if:\s*/, "").trim();
      p.corpo.push(l);
    }

    const chaves = new Set<string>();
    for (const { cond } of passos.values())
      for (const m of cond.matchAll(
        /steps\.scope\.outputs\.([A-Za-z0-9_-]+)\s*(?:!?==)\s*'false'/g,
      ))
        chaves.add(m[1]);
    expect([...chaves].sort()).toEqual(["db"]); // só `db` é decidido por expressão; `crossbrowser` é shell

    for (const chave of chaves) {
      const rodam = new Set<string>();
      const avisam = new Set<string>();
      for (const { cond, corpo } of passos.values()) {
        if (!cond.includes(`steps.scope.outputs.${chave}`)) continue;
        if (corpo.some((l) => l.includes("::notice"))) avisam.add(cond);
        else if (corpo.some((l) => /^\s*run:/.test(l))) rodam.add(cond);
      }
      expect([...rodam]).toHaveLength(1);
      expect([...avisam]).toHaveLength(1);
      const [gate] = [...rodam];
      const [aviso] = [...avisam];
      // negação exata, derivada do próprio gate (funciona tanto para `!=` quanto para `==`)
      const negacao = gate.includes("!= 'false'")
        ? gate.replace("!= 'false'", "== 'false'")
        : gate.replace("== 'false'", "!= 'false'");
      expect(aviso).toBe(negacao);
      expect(gate).toContain("!= 'false'"); // e o gate em si continua fail-closed
    }
  });

  it("N6/N10: o aviso de navegadores é derivado da decisão, não uma frase fixa", () => {
    const sh = scriptDoStep("browsers");
    // a linha de aviso tem de ser construída a partir das MESMAS variáveis que alimentam o e2e
    const linhaAviso = sh
      .split("\n")
      .filter((l) => l.includes("::notice"))
      .join("\n");
    expect(linhaAviso).toContain("${projetos}");
    expect(linhaAviso).toContain("${lista}");
    // e não pode voltar a ser prosa literal sobre quais navegadores rodam
    expect(linhaAviso).not.toMatch(/chromium\+mobile/i);
    expect(linhaAviso).not.toMatch(/firefox\+webkit/i);
  });
});

describe("WP-R8 — concurrency não cancela a fronteira de produção", () => {
  it("A3: o cancelamento é condicional a não ser a ref de `main`", () => {
    expect(YAML).toContain("cancel-in-progress: ${{ github.ref != 'refs/heads/main' }}");
  });
});
