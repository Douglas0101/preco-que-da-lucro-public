import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, describe, expect, it } from "vitest";
import {
  auditRun,
  countApplicableSteps,
  countAncestryMentions,
  driftForaDoSelo,
  extractAncestryClaims,
  parseStatusZ,
} from "../../scripts/m02-seal.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const script = resolve(root, "scripts/m02-seal.mjs");

const tmp = mkdtempSync(join(tmpdir(), "m02-seal-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

function sealFixture(name: string, files: Record<string, string>): string {
  const dir = join(tmp, name);
  mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const file = join(dir, rel);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, content);
  }
  return dir;
}

function run(args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd: root,
    encoding: "utf8",
    timeout: 30_000,
  });
}

function runIn(cwd: string, args: string[]) {
  return spawnSync(process.execPath, [script, ...args], {
    cwd,
    encoding: "utf8",
    timeout: 30_000,
  });
}

/** Repo git temporário e autocontido: a ancestralidade não depende do histórico do repo real. */
function makeGitRepo(): { dir: string; first: string; second: string } {
  const dir = mkdtempSync(join(tmp, "git-"));
  const git = (...args: string[]) => {
    const result = spawnSync("git", args, { cwd: dir, encoding: "utf8", timeout: 30_000 });
    if (result.status !== 0) {
      throw new Error(`git ${args.join(" ")} falhou: ${result.stderr}`);
    }
    return result.stdout.trim();
  };
  git("init", "-q");
  git("config", "user.email", "test@example.test");
  git("config", "user.name", "test");
  writeFileSync(join(dir, "a.txt"), "1\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "first");
  const first = git("rev-parse", "HEAD");
  writeFileSync(join(dir, "a.txt"), "2\n");
  git("add", "a.txt");
  git("commit", "-q", "-m", "second");
  const second = git("rev-parse", "HEAD");
  return { dir, first, second };
}

describe("m02-seal — manifesto e não-vacuidade", () => {
  it("selo real (SPEC + README + capturas) gera e verifica o manifesto", () => {
    const dir = sealFixture("ok", {
      "SPEC.md": "# spec\n",
      "README.md": "# readme\n",
      "captures/nota.txt": "prova\n",
    });
    const write = run(["--dir", dir, "--write"]);
    expect(write.stderr).toBe("");
    expect(write.status).toBe(0);
    const verify = run(["--dir", dir]);
    expect(verify.stdout).toContain("m02-seal: OK (3 arquivos");
    expect(verify.status).toBe(0);
  });

  it("descoberta vazia reprova (0 = 0)", () => {
    const dir = sealFixture("vazio", {});
    const result = run(["--dir", dir, "--write"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("descoberta vazia");
  });

  it("selo sem SPEC.md reprova", () => {
    const dir = sealFixture("sem-spec", { "README.md": "# readme\n" });
    const result = run(["--dir", dir, "--write"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("selo sem SPEC.md");
  });

  it("hash divergente reprova nomeando o arquivo", () => {
    const dir = sealFixture("divergente", { "SPEC.md": "a\n", "README.md": "b\n" });
    expect(run(["--dir", dir, "--write"]).status).toBe(0);
    writeFileSync(join(dir, "SPEC.md"), "c\n");
    const result = run(["--dir", dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("hash diverge");
  });

  it("MANIFEST citando arquivo ausente reprova", () => {
    const dir = sealFixture("fantasma", { "SPEC.md": "a\n", "README.md": "b\n" });
    expect(run(["--dir", dir, "--write"]).status).toBe(0);
    appendFileSync(
      join(dir, "MANIFEST.sha256"),
      `${"0".repeat(64)}  docs/evidence/fantasma/ghost.md\n`,
    );
    const result = run(["--dir", dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("MANIFEST cita arquivo ausente");
  });

  it("diretório ilegível sai com erro alto (exit 2)", () => {
    const result = run(["--dir", join(tmp, "nao-existe")]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("ilegivel");
  });

  it("sem MANIFEST e sem --write sai com erro alto (exit 2)", () => {
    const dir = sealFixture("sem-manifesto", { "SPEC.md": "a\n", "README.md": "b\n" });
    const result = run(["--dir", dir]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("MANIFEST ausente");
  });

  it("--ancestry sem valor é erro de uso (fail-high, exit 2)", () => {
    const dir = sealFixture("ancestry-sem-valor", { "SPEC.md": "a\n", "README.md": "b\n" });
    expect(run(["--dir", dir, "--write"]).status).toBe(0);
    const result = run(["--dir", dir, "--ancestry"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--ancestry exige um valor");
  });

  it("--run sem valor é erro de uso (fail-high, exit 2)", () => {
    const dir = sealFixture("run-sem-valor", { "SPEC.md": "a\n", "README.md": "b\n" });
    expect(run(["--dir", dir, "--write"]).status).toBe(0);
    const result = run(["--dir", dir, "--run"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("--run exige um valor");
  });

  it("MANIFEST com path duplicado reprova", () => {
    const dir = sealFixture("manifesto-duplicado", { "SPEC.md": "a\n", "README.md": "b\n" });
    expect(run(["--dir", dir, "--write"]).status).toBe(0);
    const manifestPath = join(dir, "MANIFEST.sha256");
    const original = readFileSync(manifestPath, "utf8");
    const primeira = original.split("\n")[0];
    const path = primeira.slice(66);
    writeFileSync(manifestPath, `${"0".repeat(64)}  ${path}\n${original}`);
    const result = run(["--dir", dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("duplicado");
  });

  it("symlink no selo reprova (não é omitido em silêncio)", () => {
    const dir = sealFixture("com-symlink", { "SPEC.md": "a\n", "README.md": "b\n" });
    symlinkSync(join(dir, "SPEC.md"), join(dir, "link.md"));
    const result = run(["--dir", dir, "--write"]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("symlink");
  });

  it("MANIFEST aninhado reprova (só o da raiz do selo é o canônico)", () => {
    const dir = sealFixture("manifesto-aninhado", { "SPEC.md": "a\n", "README.md": "b\n" });
    expect(run(["--dir", dir, "--write"]).status).toBe(0);
    mkdirSync(join(dir, "captures"), { recursive: true });
    writeFileSync(join(dir, "captures", "MANIFEST.sha256"), "lixo\n");
    const result = run(["--dir", dir]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("aninhado");
  });
});

describe("m02-seal — ancestralidade offline (formato do L133)", () => {
  it("claim verdadeira passa e é reconhecida", () => {
    const { dir: repo, first, second } = makeGitRepo();
    const dir = sealFixture("ancestral", { "SPEC.md": "a\n", "README.md": "b\n" });
    expect(runIn(repo, ["--dir", dir, "--write"]).status).toBe(0);
    writeFileSync(
      join(tmp, "ancestral.md"),
      `Medido: \`git merge-base --is-ancestor ${first} ${second}\` → exit 0.\n`,
    );
    const result = runIn(repo, ["--dir", dir, "--ancestry", join(tmp, "ancestral.md")]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("claim invertida reprova (objetos existem: o vermelho é da relação, não da ausência)", () => {
    const { dir: repo, first, second } = makeGitRepo();
    const dir = sealFixture("ancestral-falsa", { "SPEC.md": "a\n", "README.md": "b\n" });
    expect(runIn(repo, ["--dir", dir, "--write"]).status).toBe(0);
    writeFileSync(
      join(tmp, "ancestral-falsa.md"),
      `\`git merge-base --is-ancestor ${second} ${first}\` seria falso.\n`,
    );
    const result = runIn(repo, ["--dir", dir, "--ancestry", join(tmp, "ancestral-falsa.md")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ancestralidade falsa");
  });

  it("arquivo sem nenhuma claim reprova (0 = 0)", () => {
    const { dir: repo } = makeGitRepo();
    const dir = sealFixture("ancestral-vazio", { "SPEC.md": "a\n", "README.md": "b\n" });
    expect(runIn(repo, ["--dir", dir, "--write"]).status).toBe(0);
    writeFileSync(join(tmp, "ancestral-vazio.md"), "sem comando de ancestralidade aqui.\n");
    const result = runIn(repo, ["--dir", dir, "--ancestry", join(tmp, "ancestral-vazio.md")]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("nenhuma declaracao de ancestralidade");
  });

  it("extrai todas as claims do texto", () => {
    const claims = extractAncestryClaims(
      "a `git merge-base --is-ancestor abc1234 def5678` e outra `git merge-base --is-ancestor 1111111 2222222`",
    );
    expect(claims).toEqual([
      { ancestor: "abc1234", descendant: "def5678" },
      { ancestor: "1111111", descendant: "2222222" },
    ]);
  });
});

/**
 * Selo **dentro** do repositório git temporário: é a única configuração em que a precondição
 * de estado ambiente se aplica (o selo real vive em `docs/evidence/**`).
 */
function makeRepoSelo() {
  const { dir, first, second } = makeGitRepo();
  const selo = "docs/evidence/fixture";
  mkdirSync(join(dir, selo, "captures"), { recursive: true });
  writeFileSync(join(dir, selo, "SPEC.md"), "# spec\n");
  writeFileSync(join(dir, selo, "README.md"), "# readme\n");
  writeFileSync(join(dir, selo, "captures", "nota.txt"), "prova\n");
  return { repo: dir, selo, first, second };
}

describe("m02-seal — precondição de estado ambiente (INV-R5-a)", () => {
  it("deriva fora do selo reprova como PRECONDIÇÃO (exit 2), nomeando o caminho", () => {
    const { repo, selo } = makeRepoSelo();
    appendFileSync(join(repo, "a.txt"), "deriva\n");
    const result = runIn(repo, ["--dir", selo, "--write"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("PRECONDICAO");
    expect(result.stderr).toContain("a.txt");
  });

  it("worktree limpo fora do selo passa (o próprio selo não conta como deriva)", () => {
    const { repo, selo } = makeRepoSelo();
    const write = runIn(repo, ["--dir", selo, "--write"]);
    expect(write.stderr).toBe("");
    expect(write.status).toBe(0);
    const verify = runIn(repo, ["--dir", selo]);
    expect(verify.status).toBe(0);
  });

  it("selo fora do repositório declara a precondição como N/A em vez de silenciar", () => {
    const { dir: repo } = makeGitRepo();
    const dir = sealFixture("fora-do-repo", { "SPEC.md": "a\n", "README.md": "b\n" });
    const result = runIn(repo, ["--dir", dir, "--write"]);
    expect(result.status).toBe(0);
    expect(result.stdout).toContain("worktree N/A");
  });

  it("ancorar no diretório do selo fecha o contorno por cwd (invocação de fora do repo)", () => {
    const { repo, selo } = makeRepoSelo();
    appendFileSync(join(repo, "a.txt"), "deriva\n");
    const result = spawnSync(process.execPath, [script, "--dir", join(repo, selo), "--write"], {
      cwd: tmp,
      encoding: "utf8",
      timeout: 30_000,
    });
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("PRECONDICAO");
    expect(result.stderr).toContain("a.txt");
  });
});

describe("m02-seal — taxonomia de exit codes na ancestralidade (INV-R5-b)", () => {
  it("SHA inexistente é INDETERMINADO (exit 2), nunca veredito", () => {
    const { repo, selo } = makeRepoSelo();
    expect(runIn(repo, ["--dir", selo, "--write"]).status).toBe(0);
    const claim = join(tmp, "indeterminado.md");
    writeFileSync(claim, "`git merge-base --is-ancestor deadbeefdeadbeef deadbeefdeadbeef`\n");
    const result = runIn(repo, ["--dir", selo, "--ancestry", claim]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain("PRECONDICAO");
    expect(result.stderr).not.toContain("ancestralidade falsa");
  });

  it("não-ancestral com objetos presentes continua veredito (exit 1), não precondição", () => {
    const { repo, selo, first, second } = makeRepoSelo();
    expect(runIn(repo, ["--dir", selo, "--write"]).status).toBe(0);
    const claim = join(tmp, "invertida.md");
    writeFileSync(claim, `\`git merge-base --is-ancestor ${second} ${first}\`\n`);
    const result = runIn(repo, ["--dir", selo, "--ancestry", claim]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ancestralidade falsa");
  });
});

describe("m02-seal — parser do `status -z` (S6 N1/N2/N6)", () => {
  it("não cita nem escapa caminho não-ASCII (o porcelain textual citava)", () => {
    expect(parseStatusZ(" M café.txt\0")).toEqual(["café.txt"]);
    expect(parseStatusZ(" M com espaço.txt\0")).toEqual(["com espaço.txt"]);
  });

  it("rename usa o caminho novo e consome o campo do antigo", () => {
    expect(parseStatusZ("R  new.txt\0old.txt\0?? outro.md\0")).toEqual(["new.txt", "outro.md"]);
  });

  it("caminho contendo `->` não é truncado", () => {
    expect(parseStatusZ("?? docs/a -> b.md\0")).toEqual(["docs/a -> b.md"]);
  });

  it("diretório ancestral colapsado (com barra) não vira deriva", () => {
    expect(driftForaDoSelo({ porcelain: "?? docs/\0", dir: "docs/evidence/f" })).toEqual([]);
    expect(driftForaDoSelo({ porcelain: "?? outro/\0", dir: "docs/evidence/f" })).toEqual([
      "outro/",
    ]);
  });

  it("arquivos do próprio selo não são deriva; irmãos são", () => {
    const porcelain = "?? docs/evidence/f/SPEC.md\0?? docs/evidence/g/SPEC.md\0";
    expect(driftForaDoSelo({ porcelain, dir: "docs/evidence/f" })).toEqual([
      "docs/evidence/g/SPEC.md",
    ]);
  });

  it("selo em diretório com nome não-ASCII é selável (N1)", () => {
    const { dir: repo } = makeGitRepo();
    const selo = "docs/evidence/selô";
    mkdirSync(join(repo, selo, "captures"), { recursive: true });
    writeFileSync(join(repo, selo, "SPEC.md"), "# spec\n");
    writeFileSync(join(repo, selo, "README.md"), "# readme\n");
    writeFileSync(join(repo, selo, "captures", "nota.txt"), "prova\n");
    const result = runIn(repo, ["--dir", selo, "--write"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });

  it("selo em diretório contendo `->` é selável (N2)", () => {
    const { dir: repo } = makeGitRepo();
    const selo = "docs/evidence/a -> b";
    mkdirSync(join(repo, selo, "captures"), { recursive: true });
    writeFileSync(join(repo, selo, "SPEC.md"), "# spec\n");
    writeFileSync(join(repo, selo, "README.md"), "# readme\n");
    const result = runIn(repo, ["--dir", selo, "--write"]);
    expect(result.stderr).toBe("");
    expect(result.status).toBe(0);
  });
});

describe("m02-seal — ancestralidade não reconhecida não passa em silêncio (S6 N3)", () => {
  it("claim em hex MAIÚSCULO é verificada, não ignorada", () => {
    const { repo, selo, first, second } = makeRepoSelo();
    expect(runIn(repo, ["--dir", selo, "--write"]).status).toBe(0);
    const claim = join(tmp, "maiuscula.md");
    writeFileSync(
      claim,
      `\`git merge-base --is-ancestor ${first} ${second}\` (verdadeira)\n` +
        `\`git merge-base --is-ancestor ${second.toUpperCase()} ${first.toUpperCase()}\` (falsa)\n`,
    );
    const result = runIn(repo, ["--dir", selo, "--ancestry", claim]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("ancestralidade falsa");
  });

  it("comando em forma não reconhecida reprova em vez de ser pulado", () => {
    const { repo, selo, first, second } = makeRepoSelo();
    expect(runIn(repo, ["--dir", selo, "--write"]).status).toBe(0);
    const claim = join(tmp, "forma-nao-reconhecida.md");
    writeFileSync(
      claim,
      `\`git merge-base --is-ancestor ${first} ${second}\` (verdadeira)\n` +
        "`git merge-base --is-ancestor` (sem argumentos)\n",
    );
    const result = runIn(repo, ["--dir", selo, "--ancestry", claim]);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("nao verificada");
  });

  it("contagem de menções cobre hex maiúsculo e formas não-numéricas", () => {
    expect(countAncestryMentions("`git merge-base --is-ancestor ABC1234 def5678`")).toBe(1);
    expect(extractAncestryClaims("`git merge-base --is-ancestor ABC1234 def5678`")).toEqual([
      { ancestor: "ABC1234", descendant: "def5678" },
    ]);
  });
});

describe("m02-seal — a superfície de tipos é GERADA do módulo (DBT-16)", () => {
  it("os exports de runtime e as declarações de m02-seal.d.mts são o mesmo conjunto", async () => {
    const ns = await import("../../scripts/m02-seal.mjs");
    const runtime = Object.keys(ns)
      .filter((chave) => chave !== "default")
      .sort();
    const dts = readFileSync(resolve(root, "scripts/m02-seal.d.mts"), "utf8");
    const declarados = [...dts.matchAll(/^export (?:declare )?(?:function|const|class) (\w+)/gm)]
      .map((match) => match[1])
      .sort();
    // Duas direções: export sem declaração quebra o `tsc` de quem importa; declaração sem
    // export é um contrato fantasma. O `.d.mts` é gerado, mas o conjunto ainda tem de fechar.
    expect(declarados).toEqual(runtime);
  });

  it("o .d.mts no disco é byte a byte o que o gerador emite", () => {
    // Esta é a diferença entre vigiar a sincronia e eliminá-la: o WP-R5 comparava os NOMES e
    // deixava passar um tipo errado; aqui o artefato inteiro é derivado do JSDoc do módulo.
    const r = spawnSync(
      process.execPath,
      [resolve(root, "scripts/generate-seal-dts.mjs"), "--check"],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(`${r.status}: ${r.stdout}${r.stderr}`).toContain("0: generate-seal-dts");
    // o gerador invoca `tsc` + `prettier`: 5 s (default) estoura sob a suíte completa
  }, 60_000);

  it("controle negativo: uma cópia mutada do .d.mts REPROVA a conferência", () => {
    const original = readFileSync(resolve(root, "scripts/m02-seal.d.mts"), "utf8");
    const mutado = join(mkdtempSync(join(tmpdir(), "seal-dts-mut-")), "m02-seal.d.mts");
    writeFileSync(mutado, `${original}\n// linha acrescentada à mão\n`);
    const r = spawnSync(
      process.execPath,
      [resolve(root, "scripts/generate-seal-dts.mjs"), "--check", "--destino", mutado],
      { cwd: root, encoding: "utf8" },
    );
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("divergiu do modulo");
    // e o arquivo versionado segue conferindo: o controle não sujou o artefato
    const r2 = spawnSync(
      process.execPath,
      [resolve(root, "scripts/generate-seal-dts.mjs"), "--check"],
      {
        cwd: root,
        encoding: "utf8",
      },
    );
    expect(r2.status).toBe(0);
  }, 90_000);
});

describe("m02-seal — run@sha (puro)", () => {
  const commit = "c9d1740cbb9a576876ed0fd83f4e1c8bea4054cb";

  it("run no-op (todos os passos skipped) reprova como delegação", () => {
    const runJson = {
      databaseId: 1,
      headSha: commit,
      conclusion: "success",
      jobs: [{ steps: [{ conclusion: "skipped" }, { conclusion: "skipped" }] }],
    };
    const falhas = auditRun(runJson, { commit, isAncestor: () => false });
    expect(falhas.join("\n")).toContain("no-op");
  });

  it("run real da light no-op (scope guard success + checks skipped) reprova", () => {
    const runJson = {
      databaseId: 5,
      headSha: commit,
      conclusion: "success",
      jobs: [
        {
          steps: [
            { name: "Set up job", conclusion: "success" },
            {
              name: "Run actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1",
              conclusion: "success",
            },
            { name: "Scope guard (docs/evidence only)", conclusion: "success" },
            { name: "Lockfile guard (fail-closed)", conclusion: "skipped" },
            { name: "Work-package contract guard (fail-closed)", conclusion: "skipped" },
            { name: "Debt registry guard (fail-closed)", conclusion: "skipped" },
            { name: "Complete job", conclusion: "success" },
          ],
        },
      ],
    };
    expect(countApplicableSteps(runJson)).toBe(0);
    expect(auditRun(runJson, { commit, isAncestor: () => false }).join("\n")).toContain("no-op");
  });

  it("passos de infraestrutura não contam como check aplicável", () => {
    const runJson = {
      databaseId: 6,
      headSha: commit,
      conclusion: "success",
      jobs: [
        {
          steps: [
            { name: "Set up job", conclusion: "success" },
            { name: "Initialize containers", conclusion: "success" },
            { name: "Run actions/checkout@x", conclusion: "success" },
            { name: "Configure isolated runtime", conclusion: "success" },
            { name: "Post Run actions/setup-node@x", conclusion: "success" },
            { name: "Stop containers", conclusion: "success" },
          ],
        },
      ],
    };
    expect(countApplicableSteps(runJson)).toBe(0);
  });

  it("install (npm ci/npm install) não conta como check aplicável", () => {
    const runJson = {
      databaseId: 7,
      headSha: commit,
      conclusion: "success",
      jobs: [
        {
          steps: [
            {
              name: "Run npm install --global --ignore-scripts npm@11.14.1",
              conclusion: "success",
            },
            { name: "Run npm ci --ignore-scripts", conclusion: "success" },
          ],
        },
      ],
    };
    expect(countApplicableSteps(runJson)).toBe(0);
  });

  it("run substantivo (≥1 passo success) e headSha descendente passa", () => {
    const runJson = {
      databaseId: 2,
      headSha: "9659844e4012838ecef735eea630a35b03aa0b13",
      conclusion: "success",
      jobs: [{ steps: [{ conclusion: "success" }, { conclusion: "skipped" }] }],
    };
    const falhas = auditRun(runJson, {
      commit,
      isAncestor: (a: string, b: string) => a === commit && b === runJson.headSha,
    });
    expect(falhas).toEqual([]);
  });

  it("conclusion diferente de success reprova", () => {
    const runJson = {
      databaseId: 3,
      headSha: commit,
      conclusion: "failure",
      jobs: [{ steps: [{ conclusion: "success" }] }],
    };
    expect(auditRun(runJson, { commit, isAncestor: () => false }).join("\n")).toContain(
      "conclusion=failure",
    );
  });

  it("headSha nem igual nem descendente reprova", () => {
    const runJson = {
      databaseId: 4,
      headSha: "1aad70cbcf63de8c8d8a20f7b309df2b6a8ba715",
      conclusion: "success",
      jobs: [{ steps: [{ conclusion: "success" }] }],
    };
    expect(auditRun(runJson, { commit, isAncestor: () => false }).join("\n")).toContain(
      "nao e igual nem descendente",
    );
  });
});
