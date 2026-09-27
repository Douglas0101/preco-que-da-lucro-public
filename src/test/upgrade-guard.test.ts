/**
 * Controles do `upgrade-guard` (política de atualização/downgrade).
 *
 * A fixture de base é a política REAL (`scripts/dependency-policy.json`) com os specs REAIS do
 * `package.json` e as versões resolvidas REAIS do `package-lock.json`. Um cenário inventado
 * passaria mesmo com o guard inteiro quebrado; a política real não passa, e é isso que o primeiro
 * caso fixa.
 *
 * HERMETICIDADE: os controles negativos forjam DADOS, nunca disco. O núcleo recebe a política, os
 * specs, a versão resolvida, a versão instalada, os specs do HEAD e as aprovações já lidos — então
 * `drizzle-kit` rebaixado é um objeto, não um segundo `node_modules`. O único teste que toca disco
 * é o do CLI, que roda contra um diretório temporário de verdade e afirma o código de saída.
 */

import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  PREFIXO_INFORMATIVO,
  type AuditInput,
  type PolicyEntry,
  approvalFileName,
  auditDependencyPolicy,
  compareVersions,
  describeChecks,
  inRange,
  isBlockingFinding,
  parseBaseVersion,
  readPolicyEntries,
  runCli,
} from "../../scripts/lib/upgrade-guard";

const root = resolve(import.meta.dirname, "..", "..");
const tmp = mkdtempSync(join(tmpdir(), "upgrade-guard-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

interface PolicyShape {
  schema: string;
  policy: string;
  approvalsDir: string;
  packages: PolicyEntry[];
}
interface PkgShape {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}
interface LockShape {
  packages?: Record<string, { version?: string }>;
}

const readJson = <T>(file: string): T => JSON.parse(readFileSync(file, "utf8")) as T;

const realPolicy = readJson<PolicyShape>(join(root, "scripts/dependency-policy.json"));
const realPkg = readJson<PkgShape>(join(root, "package.json"));
const realLock = readJson<LockShape>(join(root, "package-lock.json"));

/** `dependencies` + `devDependencies` do `package.json` real, como o CLI coleta. */
const realSpecs: Record<string, string> = { ...realPkg.dependencies, ...realPkg.devDependencies };

/** Só os pacotes da política — o lock tem 700+ entradas e o resto não é escopo deste guard. */
const realLockResolved: Record<string, string> = {};
for (const entry of readPolicyEntries(realPolicy)) {
  const version = realLock.packages?.[`node_modules/${entry.name}`]?.version;
  if (version !== undefined) realLockResolved[entry.name] = version;
}

function installedReais(): Record<string, string> {
  const installed: Record<string, string> = {};
  for (const entry of readPolicyEntries(realPolicy)) {
    const manifest = readJson<{ version?: string }>(
      join(root, "node_modules", entry.name, "package.json"),
    );
    if (manifest.version) installed[entry.name] = manifest.version;
  }
  return installed;
}

/** Entrada real da política, pelo nome. Lança se o pacote sair do arquivo — é o próprio sinal. */
function policyEntry(name: string): PolicyEntry {
  const found = readPolicyEntries(realPolicy).find((e) => e.name === name);
  if (!found) throw new Error(`pacote ausente da política real: ${name}`);
  return found;
}

/** Política derivada da real: mesmo schema e estrutura, com o que o teste precisa falsificar. */
function policyDe(entries: Partial<PolicyEntry>[]): PolicyShape {
  return { ...realPolicy, packages: entries as PolicyEntry[] };
}

/** Entrada real com campos trocados — o resto do arquivo continua sendo o contrato real. */
function entradaReal(name: string, overrides: Partial<PolicyEntry> = {}): Partial<PolicyEntry> {
  return { ...policyEntry(name), ...overrides };
}

/** AuditInput da política real, com o mapa indicado substituído/injetado. */
function input(base: Partial<AuditInput> = {}): AuditInput {
  return {
    policy: realPolicy,
    specs: realSpecs,
    lockResolved: realLockResolved,
    installed: {},
    headSpecs: realSpecs,
    approvals: [],
    ...base,
  };
}

/** Recorta o input para UM pacote, com o resto resolvido e conforme — isola o caso em teste. */
function soEntry(name: string, base: Partial<AuditInput> = {}): AuditInput {
  return input({
    policy: policyDe([policyEntry(name)]),
    specs: { [name]: realSpecs[name] },
    lockResolved: { [name]: realLockResolved[name] },
    headSpecs: { [name]: realSpecs[name] },
    ...base,
  });
}

describe("comparação e faixa de versão", () => {
  it("compara patch numericamente, não lexicograficamente (0.31.10 > 0.31.9)", () => {
    expect(compareVersions("0.31.10", "0.31.9")).toBe(1);
    expect(compareVersions("0.31.9", "0.31.10")).toBe(-1);
  });

  it("trata versões iguais como iguais e ordena major numericamente, não como texto", () => {
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    // `10 > 2`: comparação de texto daria `10 < 2` e aceitaria um rebaixamento de major.
    expect(compareVersions("2.0.0", "10.0.0")).toBe(-1);
    expect(compareVersions("10.0.0", "2.0.0")).toBe(1);
  });

  it("inRange é inclusivo nos dois extremos", () => {
    expect(inRange("0.31.0", "0.31.0", "0.31.99")).toBe(true);
    expect(inRange("0.31.99", "0.31.0", "0.31.99")).toBe(true);
    expect(inRange("0.30.99", "0.31.0", "0.31.99")).toBe(false);
    expect(inRange("0.32.0", "0.31.0", "0.31.99")).toBe(false);
  });

  it("o teto `major.99.99` da política real é lido como a linha inteira do major", () => {
    // `@tanstack/react-start` é `1.168.0 .. 1.99.99`. Lido como trio cru, min > max e a política
    // real seria inválida por construção. O `99` do minor é CORINGA: a faixa é [1.168.0, 2.0.0).
    const start = policyEntry("@tanstack/react-start");
    expect(inRange("1.168.26", start.min, start.max)).toBe(true);
    // Minor ACIMA de 99 é o que o coringa existe para admitir: 200 > 99, mas é a mesma linha 1.x.
    expect(inRange("1.200.0", start.min, start.max)).toBe(true);
    expect(inRange("1.170.32", start.min, start.max)).toBe(true);
    // Minor ABAIXO do piso continua fora, mesmo sendo menor que 99.
    expect(inRange("1.167.99", start.min, start.max)).toBe(false);
    expect(inRange("1.99.5", start.min, start.max)).toBe(false);
    expect(inRange("2.0.0", start.min, start.max)).toBe(false);
  });

  it("parseBaseVersion extrai a menor versão declarada e devolve null sem versão reconhecível", () => {
    expect(parseBaseVersion("^0.31.10")).toBe("0.31.10");
    expect(parseBaseVersion("~1.2.3")).toBe("1.2.3");
    expect(parseBaseVersion("1.2.3")).toBe("1.2.3");
    expect(parseBaseVersion(">=1.2.3")).toBe("1.2.3");
    // Faixa com dois lados: o piso declarado é o que o autor pinou.
    expect(parseBaseVersion(">=1.2.3 <2.0.0")).toBe("1.2.3");
    expect(parseBaseVersion("1.2.3 - 2.3.4")).toBe("1.2.3");
    expect(parseBaseVersion("0.31.10-rc.1")).toBe("0.31.10");
    expect(parseBaseVersion("workspace:*")).toBeNull();
    expect(parseBaseVersion("latest")).toBeNull();
    expect(parseBaseVersion("file:../drizzle-kit")).toBeNull();
  });
});

describe("política real contra a árvore real", () => {
  it("a política real com os specs e versões resolvidas reais não produz finding", () => {
    expect(auditDependencyPolicy(input())).toEqual([]);
  });

  it("com o node_modules instalado real, também não produz finding", () => {
    const installed = installedReais();
    expect(Object.keys(installed).length).toBeGreaterThan(0);
    expect(auditDependencyPolicy(input({ installed }))).toEqual([]);
  });

  it("todo check da política real sai `pass` — nenhum `skip` nem `fail` silencioso", () => {
    const checks = describeChecks(input({ installed: installedReais() }));
    expect(checks.filter((c) => c.status === "skip")).toEqual([]);
    expect(checks.filter((c) => c.status === "fail")).toEqual([]);
  });
});

describe("incidente real: drizzle-kit rebaixado de ^0.31.10 para ^0.18.1", () => {
  // Este é o WIP que quebrou `npm run typecheck` e `npm run m02:lockfile-guard`. O spec rebaixado
  // viola a faixa E é downgrade de `critical` — dois motivos de reprovar, e o teste exige o
  // segundo explicitamente, porque é o que a aprovação existe para controlar.
  const rebaixado = input({
    specs: { ...realSpecs, "drizzle-kit": "^0.18.1" },
    lockResolved: { ...realLockResolved, "drizzle-kit": "0.18.1" },
  });

  it("sem Downgrade Request, o rebaixamento de pacote critical é reprovado", () => {
    const doDowngrade = auditDependencyPolicy(rebaixado)
      .filter(isBlockingFinding)
      .filter((f) => f.includes("(downgrade)"));
    expect(doDowngrade).toHaveLength(1);
    // Nomeia pacote, as DUAS versões, diz que é downgrade e diz qual arquivo autorizaria.
    expect(doDowngrade[0]).toContain("drizzle-kit");
    expect(doDowngrade[0]).toContain("0.18.1");
    expect(doDowngrade[0]).toContain("0.31.10");
    expect(doDowngrade[0]).toContain("downgrade");
    expect(doDowngrade[0]).toContain("drizzle-kit__0.31.10__0.18.1.json");
  });

  it("o rebaixamento também viola a faixa da spec — não só a regra de aprovação", () => {
    const specFinding = auditDependencyPolicy(rebaixado).find((f) =>
      f.startsWith("drizzle-kit (spec)"),
    );
    expect(specFinding).toBe(
      "drizzle-kit (spec): observado 0.18.1, esperado 0.31.0 <= versão <= 0.31.99",
    );
  });

  it("com o arquivo de aprovação presente, o rebaixamento deixa de ser finding", () => {
    const comAprovacao = auditDependencyPolicy({
      ...rebaixado,
      approvals: ["drizzle-kit__0.31.10__0.18.1.json"],
    }).filter(isBlockingFinding);
    // A aprovação cobre o DOWNGRADE, não a faixa: 0.18.1 continua fora de 0.31.0..0.31.99, então
    // o finding de spec permanece. Se ele sumisse, a aprovação estaria virando atalho para
    // desligar a política.
    expect(comAprovacao.filter((f) => f.includes("(downgrade)"))).toEqual([]);
    expect(comAprovacao).toContain(
      "drizzle-kit (spec): observado 0.18.1, esperado 0.31.0 <= versão <= 0.31.99",
    );
  });

  it("o nome do arquivo de aprovação sai de nome, versão antiga e versão nova", () => {
    expect(approvalFileName("drizzle-kit", "0.31.10", "0.18.1")).toBe(
      "drizzle-kit__0.31.10__0.18.1.json",
    );
    // Nome com escopo e barra tem de virar nome de arquivo utilizável.
    expect(approvalFileName("@neondatabase/serverless", "1.1.0", "1.0.0")).toBe(
      "_neondatabase_serverless__1.1.0__1.0.0.json",
    );
  });
});

describe("ausência também é violação", () => {
  it("pacote listado na política e ausente do package.json é reprovado", () => {
    const semDrizzleKit = { ...realSpecs };
    delete semDrizzleKit["drizzle-kit"];
    expect(auditDependencyPolicy(input({ specs: semDrizzleKit }))).toContain(
      "drizzle-kit (package.json): observado ausente, esperado declarado em dependencies ou devDependencies",
    );
  });

  it("lock sem a entrada do pacote NÃO é finding — e o check sai `skip`, não `pass`", () => {
    const semLock = { ...realLockResolved };
    delete semLock["drizzle-kit"];
    const comInput = soEntry("drizzle-kit", { lockResolved: semLock });
    expect(auditDependencyPolicy(comInput)).toEqual([]);

    const check = describeChecks(comInput).find((c) => c.id === "lock:drizzle-kit");
    expect(check?.status).toBe("skip");
    expect(check?.detail).toContain("sem entrada node_modules/drizzle-kit");
    expect(check?.detail).toContain("não conferido");
  });

  it("lock PRESENTE e fora da faixa é reprovado — o skip acima não é um pass disfarçado", () => {
    expect(
      auditDependencyPolicy(soEntry("drizzle-kit", { lockResolved: { "drizzle-kit": "0.18.1" } })),
    ).toContain("drizzle-kit (lockfile): observado 0.18.1, esperado 0.31.0 <= versão <= 0.31.99");
  });

  it("node_modules sem o pacote NÃO é finding — CI leve não instala dependências", () => {
    const comInput = soEntry("drizzle-kit", { installed: {} });
    expect(auditDependencyPolicy(comInput)).toEqual([]);
    expect(describeChecks(comInput).find((c) => c.id === "installed:drizzle-kit")?.status).toBe(
      "skip",
    );
  });

  it("versão instalada fora da faixa é reprovada", () => {
    expect(
      auditDependencyPolicy(soEntry("drizzle-kit", { installed: { "drizzle-kit": "0.18.1" } })),
    ).toContain(
      "drizzle-kit (node_modules): observado 0.18.1, esperado 0.31.0 <= versão <= 0.31.99",
    );
  });

  it("HEAD indisponível deixa o downgrade como `skip` nomeado, nunca como `pass`", () => {
    const comInput = soEntry("drizzle-kit", { headSpecs: {} });
    expect(auditDependencyPolicy(comInput)).toEqual([]);
    const check = describeChecks(comInput).find((c) => c.id === "downgrade:drizzle-kit");
    expect(check?.status).toBe("skip");
    expect(check?.detail).toContain("git indisponível");
  });
});

describe("estrutura da política é fail-closed", () => {
  it("criticality fora do conjunto é finding, não exceção", () => {
    expect(
      auditDependencyPolicy(
        input({ policy: policyDe([entradaReal("drizzle-kit", { criticality: "low" as never })]) }),
      ),
    ).toContain(
      'drizzle-kit (criticalidade): observado "low", esperado "critical" | "high" | "medium"',
    );
  });

  it("min maior que max é finding — faixa impossível reprova", () => {
    expect(
      auditDependencyPolicy(
        input({ policy: policyDe([entradaReal("drizzle-kit", { min: "2.0.0", max: "1.0.0" })]) }),
      ),
    ).toContain(
      "drizzle-kit (faixa): observado min 2.0.0 maior que max 1.0.0, esperado min <= max",
    );
  });

  it("faixa degenerada 0.0.0 é finding — ela liberaria qualquer versão", () => {
    expect(
      auditDependencyPolicy(
        input({ policy: policyDe([entradaReal("drizzle-kit", { min: "0.0.0", max: "0.31.99" })]) }),
      ),
    ).toContain(
      "drizzle-kit (min): observado 0.0.0, esperado min maior que 0.0.0 (faixa degenerada)",
    );
  });

  it("name duplicado é finding, e a duplicata não abre espaço para a faixa mais permissiva", () => {
    // A PRIMEIRA entrada tem faixa estreita (0.40.x) e a SEGUNDA é permissiva (0.31..0.40). O spec
    // real é ^0.31.10: ele passa na segunda e reprova na primeira. Se o guard pegasse a última
    // entrada, o pacote escaparia da faixa que o autor escreveu primeiro — daí a assimetria.
    const findings = auditDependencyPolicy(
      input({
        policy: policyDe([
          entradaReal("drizzle-kit", { min: "0.40.0", max: "0.40.99" }),
          entradaReal("drizzle-kit", { min: "0.31.0", max: "0.40.99" }),
        ]),
      }),
    );
    expect(findings).toContain(
      "drizzle-kit (nome): observado entrada duplicada na política, esperado uma entrada por pacote",
    );
    expect(findings).toContain(
      "drizzle-kit (spec): observado 0.31.10, esperado 0.40.0 <= versão <= 0.40.99",
    );
  });

  it("name vazio é finding", () => {
    expect(
      auditDependencyPolicy(
        input({ policy: policyDe([entradaReal("drizzle-kit", { name: "   " })]) }),
      ),
    ).toContain("política[0] (nome): observado name ausente ou vazio, esperado nome de pacote");
  });

  it("schema errado é finding", () => {
    expect(
      auditDependencyPolicy(input({ policy: { ...realPolicy, schema: "dependency-policy/2" } })),
    ).toContain(
      'política (schema): observado "dependency-policy/2", esperado "dependency-policy/1"',
    );
  });

  it("packages ausente ou não-lista é finding, e a política inteira cai fora do guard", () => {
    expect(
      auditDependencyPolicy(input({ policy: { ...realPolicy, packages: undefined as never } })),
    ).toContain("política (packages): observado ausente, esperado lista de entradas");

    const findings = auditDependencyPolicy(
      input({ policy: { ...realPolicy, packages: { drizzle: true } as never } }),
    );
    expect(findings.some((f) => f.startsWith("política (packages):"))).toBe(true);
  });

  it("min ou max ilegível é finding, e o pacote não sai do guard", () => {
    expect(
      auditDependencyPolicy(
        input({ policy: policyDe([entradaReal("drizzle-kit", { min: "^0.31" })]) }),
      ),
    ).toContain(
      'drizzle-kit (min): observado "^0.31", esperado versão reconhecível em major.minor.patch',
    );
    expect(
      auditDependencyPolicy(input({ policy: policyDe([entradaReal("drizzle-kit", { max: "" })]) })),
    ).toContain(
      'drizzle-kit (max): observado "", esperado versão reconhecível em major.minor.patch',
    );
  });
});

describe("spec não reconhecível é finding, não exceção", () => {
  it.each([["workspace:*"], ["latest"], ["*"], ["file:../drizzle-kit"]])(
    "spec %s é reprovada nomeando a spec observada",
    (spec) => {
      expect(
        auditDependencyPolicy(soEntry("drizzle-kit", { specs: { "drizzle-kit": spec } })),
      ).toContain(
        `drizzle-kit (spec): observado ${JSON.stringify(spec)}, esperado versão reconhecível em major.minor.patch`,
      );
    },
  );
});

describe("rebaixamento de high é informativo e não bloqueia", () => {
  // `vite` é `high` (8.0.0..8.99.99). Rebaixar DENTRO da faixa não viola a política, mas é
  // downgrade e precisa aparecer — sem virar reprovação, e sem sumir do relatório.
  const rebaixadoVite = input({
    specs: { ...realSpecs, vite: "^8.0.1" },
    lockResolved: { ...realLockResolved, vite: "8.0.1" },
  });

  it("o finding existe, nomeia as duas versões e diz explicitamente que não bloqueia", () => {
    const doVite = auditDependencyPolicy(rebaixadoVite).filter((f) =>
      f.includes("vite (downgrade)"),
    );
    expect(doVite).toHaveLength(1);
    expect(doVite[0]).toContain("8.0.1");
    expect(doVite[0]).toContain("8.0.16");
    expect(doVite[0]).toContain("NÃO bloqueia o guard");
    expect(doVite[0].startsWith(PREFIXO_INFORMATIVO)).toBe(true);
  });

  it("por ser informativo, não entra em reasons: o veredito do guard continua limpo", () => {
    const findings = auditDependencyPolicy(rebaixadoVite);
    expect(findings).not.toEqual([]);
    expect(findings.filter(isBlockingFinding)).toEqual([]);
  });

  it("subir ou manter a versão não gera finding nenhum", () => {
    expect(
      auditDependencyPolicy(
        input({
          specs: { ...realSpecs, vite: "^8.2.2" },
          lockResolved: { ...realLockResolved, vite: "8.2.2" },
        }),
      ),
    ).toEqual([]);
  });

  it("a aprovação é exigida só para critical: ela não muda o veredito de um pacote high", () => {
    const semAprovacao = auditDependencyPolicy(rebaixadoVite).filter(isBlockingFinding);
    const comAprovacao = auditDependencyPolicy({
      ...rebaixadoVite,
      approvals: ["vite__8.0.16__8.0.1.json"],
    }).filter(isBlockingFinding);
    expect(semAprovacao).toEqual(comAprovacao);
    expect(semAprovacao).toEqual([]);
  });

  it("o check de downgrade de high sai `skip` carregando o texto do finding, não `pass`", () => {
    const check = describeChecks(rebaixadoVite).find((c) => c.id === "downgrade:vite");
    expect(check?.status).toBe("skip");
    expect(check?.detail).toContain("NÃO bloqueia o guard");
  });
});

describe("CLI: precondição nunca é pass", () => {
  /** Roda o CLI capturing o relatório, para o teste poder afirmar código E conteúdo. */
  function cli(cwd: string): { codigo: 0 | 1 | 2; stdout: string } {
    const original = process.stdout.write.bind(process.stdout);
    let buffer = "";
    process.stdout.write = ((chunk: string | Uint8Array): boolean => {
      buffer += typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk);
      return true;
    }) as typeof process.stdout.write;
    try {
      return { codigo: runCli(cwd), stdout: buffer };
    } finally {
      process.stdout.write = original;
    }
  }

  it("política ausente em diretório temporário devolve 2 com a razão nomeada", () => {
    const { codigo, stdout } = cli(tmp);
    expect(codigo).toBe(2);
    const relatorio = JSON.parse(stdout);
    expect(relatorio.ok).toBe(false);
    expect(relatorio.status).toBe("fail");
    expect(relatorio.reasons).toContain("politica ausente ou malformada");
  });

  it("package.json ausente é precondição 2, não veredito 1", () => {
    const semManifest = mkdtempSync(join(tmpdir(), "upgrade-guard-sem-manifest-"));
    mkdirSync(join(semManifest, "scripts"), { recursive: true });
    writeFileSync(
      join(semManifest, "scripts", "dependency-policy.json"),
      JSON.stringify(realPolicy),
    );
    try {
      const { codigo, stdout } = cli(semManifest);
      expect(codigo).toBe(2);
      expect(JSON.parse(stdout).reasons.join(" ")).toContain("package.json");
    } finally {
      rmSync(semManifest, { recursive: true, force: true });
    }
  });

  it("package.json com JSON malformado é precondição 2", () => {
    const quebrado = mkdtempSync(join(tmpdir(), "upgrade-guard-json-quebrado-"));
    mkdirSync(join(join(quebrado, "scripts")), { recursive: true });
    writeFileSync(join(quebrado, "scripts", "dependency-policy.json"), JSON.stringify(realPolicy));
    writeFileSync(join(quebrado, "package.json"), "{ isto nao e json");
    writeFileSync(join(quebrado, "package-lock.json"), JSON.stringify({ packages: {} }));
    try {
      const { codigo, stdout } = cli(quebrado);
      expect(codigo).toBe(2);
      expect(JSON.parse(stdout).reasons.join(" ")).toContain("JSON malformado");
    } finally {
      rmSync(quebrado, { recursive: true, force: true });
    }
  });

  it("a árvore real devolve 0 e um relatório `pass`", () => {
    const { codigo, stdout } = cli(root);
    const relatorio = JSON.parse(stdout);
    expect(codigo).toBe(0);
    expect(relatorio.ok).toBe(true);
    expect(relatorio.status).toBe("pass");
    expect(relatorio.reasons).toEqual([]);
    expect(relatorio.observed.policyPackages).toBe(readPolicyEntries(realPolicy).length);
  });
});
