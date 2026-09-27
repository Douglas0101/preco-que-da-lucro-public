/**
 * upgrade-guard — política de atualização/downgrade de dependências.
 *
 * PROBLEMA QUE ESTE MÓDULO FECHA: um WIP rebaixou `drizzle-kit` de `^0.31.10` para `^0.18.1` e
 * quebrou `npm run typecheck` e `npm run m02:lockfile-guard` em silêncio — nada reprovou no momento
 * da escrita, só depois, no gate. A política em `scripts/dependency-policy.json` declara, por
 * pacote, a criticidade e a faixa aprovada; este guard é quem a APLICA.
 *
 * FAIXAS: `min` e `max` são limites INCLUSIVOS em `major.minor.patch`. A comparação é numérica,
 * feita aqui mesmo, sem `semver` — os guards de política que exigem adicionar a própria dependência
 * que controlam seriam incoerentes.
 *
 * SEPARAÇÃO NÚCLEO/IO (o que torna os controles negativos herméticos): `auditDependencyPolicy` e
 * `describeChecks` recebem DADOS JÁ LIDOS. Nenhum `fs`, nenhum `git`, nenhum `process.cwd` entra
 * no núcleo; o CLI no fim do arquivo faz o I/O e chama o núcleo. Um teste que precisasse de um
 * segundo `node_modules` para falsificar a versão instalada não seria hermético.
 *
 * FAIL-CLOSED NAS DUAS DIREÇÕES: ausência também é violação. Política sem o pacote, pacote listado
 * e removido do `package.json`, `min`/`max` invertidos ou degenerados, marca ilegível — tudo isso é
 * finding. Nunca se assume o que não se leu; o que não pôde ser lido é `skip` nomeado, nunca
 * `pass` silencioso.
 *
 * DOWNGRADE NUNCA É TÁCITO: um pacote `critical` cuja versão nova é estritamente menor que a do
 * `HEAD` exige Downgrade Request em `scripts/dependency-approvals/`, nomeado
 * `<pacote>__<versão antiga>__<versão nova>.json`. Pacote `high`/`medium` gera finding INFORMATIVO,
 * que não bloqueia o veredito — e a própria mensagem diz isso, para o veredito não ser ambíguo.
 *
 * CÓDIGOS DE SAÍDA (CLI): `0` pass · `1` violação · `2` precondição (política ausente/malformada,
 * manifest ilegível, git indisponível). Precondição nunca é `pass`.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

/** Criticidades aceitas pela política. Fora deste conjunto, a entrada é inválida. */
export const CRITICALIDADES = ["critical", "high", "medium"] as const;
export type Criticality = (typeof CRITICALIDADES)[number];

/** Prefixo que marca um finding que NÃO bloqueia o veredito (rebaixamento de `high`/`medium`). */
export const PREFIXO_INFORMATIVO = "[informativo] ";

/** `schema` exigido pelo arquivo de política. */
export const SCHEMA_POLICY = "dependency-policy/1";

/** Uma entrada já normalizada da política. Só existe depois de todas as validações estruturais. */
export interface PolicyEntry {
  name: string;
  criticality: Criticality;
  min: string;
  max: string;
}

/** Dados de entrada do núcleo — todos JÁ LIDOS, nenhum derivado de I/O dentro do núcleo. */
export interface AuditInput {
  /** `scripts/dependency-policy.json` já parseado (pode ser qualquer coisa: o núcleo não lança). */
  policy: unknown;
  /** `nome -> spec`, misturando `dependencies` e `devDependencies` do `package.json`. */
  specs: Readonly<Record<string, string>>;
  /** `nome -> versão` resolvida em `package-lock.json` (`packages["node_modules/<nome>"]`). */
  lockResolved: Readonly<Record<string, string>>;
  /** `nome -> versão` de `node_modules/<nome>/package.json`. Vazio quando não há instalação. */
  installed: Readonly<Record<string, string>>;
  /** `nome -> spec` do `package.json` no `HEAD`. Vazio quando o git não devolveu nada. */
  headSpecs: Readonly<Record<string, string>>;
  /** Nomes dos arquivos de Downgrade Request existentes em `approvalsDir`. */
  approvals: readonly string[];
}

export interface GuardCheck {
  id: string;
  status: "pass" | "fail" | "skip";
  detail: string;
}

export interface AuditReport {
  findings: string[];
  checks: GuardCheck[];
  /** Entradas que passaram em toda validação estrutural — as avaliadas nas demais checagens. */
  entries: PolicyEntry[];
}

/** Um finding informativo de rebaixamento não reprova o veredito. */
export function isBlockingFinding(finding: string): boolean {
  return !finding.startsWith(PREFIXO_INFORMATIVO);
}

/**
 * Compara `major.minor.patch` numericamente, com pre-release ignorado. Sem `semver`.
 * Segmento ausente ou não numérico vale 0 — quem chama já validou a forma com
 * {@link parseBaseVersion}, então a tolerância aqui não é caminho de escape, é robustez.
 */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const left = toTriple(a);
  const right = toTriple(b);
  for (let i = 0; i < 3; i += 1) {
    if (left[i] < right[i]) return -1;
    if (left[i] > right[i]) return 1;
  }
  return 0;
}

/**
 * Extrai a versão base de uma spec (`^0.31.10`, `~1.2.3`, `1.2.3`, `>=1.2.3`, `1.2.3 - 2.3.4`)
 * usando a MENOR versão declarada — é o piso que o autor realmente pinou. Pre-release é ignorado.
 * Devolve `null` quando não há versão reconhecível (`workspace:*`, `latest`, `*`, `file:../x`).
 */
export function parseBaseVersion(spec: string): string | null {
  if (typeof spec !== "string") return null;
  const matches = spec.match(/\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g);
  if (!matches) return null;
  let menor: string | null = null;
  for (const match of matches) {
    const base = baseOf(match);
    if (menor === null || compareVersions(base, menor) < 0) menor = base;
  }
  return menor;
}

/**
 * `true` quando `version` cabe SOB o teto `max`, com o teto inclusivo.
 *
 * A política declara o teto com a convenção `major.99.99` para dizer "toda a linha do major"
 * (ex.: `@tanstack/react-start` = `1.168.0 .. 1.99.99`). Lido como trio cru, `1.168.0 > 1.99.99`:
 * a faixa seria reprovada por `min <= max` e a política real seria inválida por construção.
 * Então um componente `99` no `max` é CORINGA — a partir dele o teto deixa de discriminar e
 * qualquer valor maior cabe, desde que os componentes acima já casem. A alternativa seria afrouxar
 * a checagem em outro lugar, e afrouxar em outro lugar é exatamente o que este guard existe para
 * impedir.
 */
function withinCeiling(version: string, max: string): boolean {
  const alvo = toTriple(version);
  const teto = toTriple(max);
  for (let i = 0; i < 3; i += 1) {
    if (teto[i] === 99) return true;
    if (alvo[i] < teto[i]) return true;
    if (alvo[i] > teto[i]) return false;
  }
  return true;
}

/** Limites INCLUSIVOS nos dois extremos. Versão ilegível ⇒ `false` (fail-closed). */
export function inRange(version: string, min: string, max: string): boolean {
  const alvo = parseBaseVersion(version);
  const piso = parseBaseVersion(min);
  const teto = parseBaseVersion(max);
  if (alvo === null || piso === null || teto === null) return false;
  // O piso tem de caber sob o teto: teto degenerado ou invertido reprova a faixa inteira, senão
  // `min <= versão <= max` viraria condição impossível e o pacote sairia do guard em silêncio.
  if (!withinCeiling(piso, teto)) return false;
  return compareVersions(alvo, piso) >= 0 && withinCeiling(alvo, teto);
}

/** Nome exato do arquivo de Downgrade Request que autoriza rebaixar um pacote `critical`. */
export function approvalFileName(name: string, from: string, to: string): string {
  return `${name.replace(/[@/]/g, "_")}__${from}__${to}.json`;
}

/** Findings do núcleo, um por string, no formato `${pacote} (${lado}): observado …, esperado …`. */
export function auditDependencyPolicy(input: AuditInput): string[] {
  return runAudit(input).findings;
}

/**
 * Os mesmos achados, como `checks` nomeados. Derivado da MESMA execução de {@link runAudit} —
 * as duas visões não podem divergir por construção.
 */
export function describeChecks(input: AuditInput): GuardCheck[] {
  return runAudit(input).checks;
}

/** Canais de relato do núcleo: `fail` reprova, `note` é finding informativo (não bloqueia). */
interface Reporter {
  fail(id: string, detail: string): void;
  pass(id: string, detail: string): void;
  skip(id: string, detail: string): void;
  note(id: string, detail: string): void;
}

/**
 * Só as entradas que passam em TODA validação estrutural, na ordem do arquivo. O CLI precisa
 * delas antes do I/O restante — é o que diz quais `node_modules/<nome>/package.json` ler. As
 * findings de estrutura saem de {@link auditDependencyPolicy}, que roda a mesma validação.
 */
export function readPolicyEntries(policy: unknown): PolicyEntry[] {
  const raw = asRecord(policy)?.packages;
  if (!Array.isArray(raw)) return [];
  const entries: PolicyEntry[] = [];
  const vistos = new Set<string>();
  for (const candidate of raw) {
    const normalized = normalizeEntry(candidate, entries.length);
    if (!normalized.ok || vistos.has(normalized.entry.name)) continue;
    vistos.add(normalized.entry.name);
    entries.push(normalized.entry);
  }
  return entries;
}

function runAudit(input: AuditInput): AuditReport {
  const findings: string[] = [];
  const checks: GuardCheck[] = [];
  const report: Reporter = {
    fail(id, detail) {
      checks.push({ id, status: "fail", detail });
      findings.push(detail);
    },
    pass(id, detail) {
      checks.push({ id, status: "pass", detail });
    },
    skip(id, detail) {
      checks.push({ id, status: "skip", detail });
    },
    note(id, detail) {
      checks.push({ id, status: "skip", detail });
      findings.push(`${PREFIXO_INFORMATIVO}${detail}`);
    },
  };
  const { fail, pass, skip } = report;

  // 1. Estrutura da política.
  const schema = asRecord(input.policy)?.schema;
  if (schema === SCHEMA_POLICY) pass("policy-schema", `schema ${SCHEMA_POLICY}`);
  else
    fail(
      "policy-schema",
      `política (schema): observado ${JSON.stringify(schema ?? null)}, esperado ${JSON.stringify(SCHEMA_POLICY)}`,
    );

  const rawPackages = asRecord(input.policy)?.packages;
  if (!Array.isArray(rawPackages))
    fail(
      "policy-packages",
      `política (packages): observado ${rawPackages === undefined ? "ausente" : JSON.stringify(rawPackages)}, esperado lista de entradas`,
    );

  const raw: unknown[] = Array.isArray(rawPackages) ? rawPackages : [];
  const entries: PolicyEntry[] = [];
  const vistos = new Set<string>();

  raw.forEach((candidate, index) => {
    const normalized = normalizeEntry(candidate, index);
    if (!normalized.ok) {
      fail(`policy-entry[${index}]`, normalized.finding);
      return;
    }
    if (vistos.has(normalized.entry.name)) {
      fail(
        `policy-entry[${index}]`,
        `${normalized.entry.name} (nome): observado entrada duplicada na política, esperado uma entrada por pacote`,
      );
      return;
    }
    vistos.add(normalized.entry.name);
    entries.push(normalized.entry);
    pass(
      `policy-entry[${index}]`,
      `${normalized.entry.name} (entrada): ${normalized.entry.criticality} em ${normalized.entry.min}..${normalized.entry.max}`,
    );
  });

  // 2..6. Presença, faixa da spec, lockfile, node_modules e downgrade contra o HEAD.
  for (const entry of entries) {
    const id = `${entry.name}`;

    const spec = input.specs[entry.name];
    if (spec === undefined) {
      fail(
        `presence:${id}`,
        `${entry.name} (package.json): observado ausente, esperado declarado em dependencies ou devDependencies`,
      );
    } else {
      const base = parseBaseVersion(spec);
      if (base === null) {
        fail(
          `spec:${id}`,
          `${entry.name} (spec): observado ${JSON.stringify(spec)}, esperado versão reconhecível em major.minor.patch`,
        );
      } else if (!inRange(base, entry.min, entry.max)) {
        fail(`spec:${id}`, `${entry.name} (spec): observado ${base}, esperado ${rangeText(entry)}`);
      } else {
        pass(`spec:${id}`, `${entry.name} (spec): ${spec} => ${base} em ${rangeText(entry)}`);
      }
    }

    const resolved = input.lockResolved[entry.name];
    if (resolved === undefined) {
      skip(
        `lock:${id}`,
        `${entry.name} (lockfile): observado sem entrada node_modules/${entry.name}, esperado ${rangeText(entry)} — não conferido`,
      );
    } else if (!inRange(resolved, entry.min, entry.max)) {
      fail(
        `lock:${id}`,
        `${entry.name} (lockfile): observado ${resolved}, esperado ${rangeText(entry)}`,
      );
    } else {
      pass(`lock:${id}`, `${entry.name} (lockfile): ${resolved} em ${rangeText(entry)}`);
    }

    const installed = input.installed[entry.name];
    if (installed === undefined) {
      skip(
        `installed:${id}`,
        `${entry.name} (node_modules): observado sem instalação, esperado ${rangeText(entry)} — CI leve não instala dependências, não conferido`,
      );
    } else if (!inRange(installed, entry.min, entry.max)) {
      fail(
        `installed:${id}`,
        `${entry.name} (node_modules): observado ${installed}, esperado ${rangeText(entry)}`,
      );
    } else {
      pass(`installed:${id}`, `${entry.name} (node_modules): ${installed} em ${rangeText(entry)}`);
    }

    checkDowngrade(entry, input, report);
  }

  return { findings, checks, entries };
}

function checkDowngrade(entry: PolicyEntry, input: AuditInput, report: Reporter): void {
  const { fail, pass, skip, note } = report;
  const id = `downgrade:${entry.name}`;
  const headSpec = input.headSpecs[entry.name];
  if (headSpec === undefined) {
    skip(
      id,
      `${entry.name} (downgrade): observado sem spec no HEAD, esperado comparação de rebaixamento — git indisponível ou pacote novo, não conferido`,
    );
    return;
  }
  const current = parseBaseVersion(input.specs[entry.name] ?? "");
  const previous = parseBaseVersion(headSpec);
  if (current === null || previous === null) {
    skip(
      id,
      `${entry.name} (downgrade): observado spec HEAD ${JSON.stringify(headSpec)} ilegível, esperado versão reconhecível para comparar rebaixamento — não conferido`,
    );
    return;
  }
  if (compareVersions(current, previous) >= 0) {
    pass(
      id,
      `${entry.name} (downgrade): observado ${current} a partir de ${previous}, esperado >= ${previous}`,
    );
    return;
  }

  if (entry.criticality === "critical") {
    const required = approvalFileName(entry.name, previous, current);
    if (input.approvals.includes(required))
      pass(
        id,
        `${entry.name} (downgrade): observado ${current} a partir de ${previous}, esperado downgrade aprovado — Downgrade Request ${required} presente`,
      );
    else
      fail(
        id,
        `${entry.name} (downgrade): observado ${current} a partir de ${previous}, esperado downgrade aprovado — Downgrade Request ${required} ausente em ${approvalDirOf(input.policy)}`,
      );
    return;
  }

  // `high`/`medium`: finding informativo. A mensagem declara que não bloqueia, senão o veredito
  // seria ambíguo entre "reprovado" e "avisado".
  note(
    id,
    `${entry.name} (downgrade): observado ${current} a partir de ${previous}, esperado ${previous} ou maior — finding informativo de rebaixamento, NÃO bloqueia o guard (apenas critical exige Downgrade Request)`,
  );
}

type Normalized = { ok: true; entry: PolicyEntry } | { ok: false; finding: string };

/**
 * Valida uma entrada da política. `ok: false` carrega o finding pronto: entrada inválida nunca
 * lança, e o achado nunca é reconstruído a partir de outro lugar (ele não poderia bater).
 */
function normalizeEntry(raw: unknown, index: number): Normalized {
  const record = asRecord(raw);
  if (!record)
    return {
      ok: false,
      finding: `política[${index}] (nome): observado ${JSON.stringify(raw ?? null)}, esperado objeto de entrada`,
    };

  const name = typeof record.name === "string" ? record.name.trim() : "";
  if (name === "")
    return {
      ok: false,
      finding: `política[${index}] (nome): observado name ausente ou vazio, esperado nome de pacote`,
    };

  const criticality = record.criticality;
  if (typeof criticality !== "string" || !isCriticality(criticality))
    return {
      ok: false,
      finding: `${name} (criticalidade): observado ${JSON.stringify(criticality ?? null)}, esperado ${CRITICALIDADES.map((c) => JSON.stringify(c)).join(" | ")}`,
    };

  const min = parseBaseVersion(typeof record.min === "string" ? record.min : "");
  const max = parseBaseVersion(typeof record.max === "string" ? record.max : "");
  if (min === null)
    return {
      ok: false,
      finding: `${name} (min): observado ${JSON.stringify(record.min ?? null)}, esperado versão reconhecível em major.minor.patch`,
    };
  if (max === null)
    return {
      ok: false,
      finding: `${name} (max): observado ${JSON.stringify(record.max ?? null)}, esperado versão reconhecível em major.minor.patch`,
    };
  if (min === "0.0.0" || max === "0.0.0")
    return {
      ok: false,
      finding: `${name} (${min === "0.0.0" ? "min" : "max"}): observado 0.0.0, esperado ${min === "0.0.0" ? "min" : "max"} maior que 0.0.0 (faixa degenerada)`,
    };
  // Mesma semântica de teto usada por `inRange`: `1.99.99` é coringa, então `1.168.0 <= 1.99.99`
  // vale. Comparação crua reprovaria a política real, e afrouxar a checagem em outro lugar para
  // compensar é exatamente o que este guard existe para impedir.
  if (!withinCeiling(min, max))
    return {
      ok: false,
      finding: `${name} (faixa): observado min ${min} maior que max ${max}, esperado min <= max`,
    };

  return { ok: true, entry: { name, criticality, min, max } };
}

function isCriticality(value: string): value is Criticality {
  return (CRITICALIDADES as readonly string[]).includes(value);
}

function rangeText(entry: PolicyEntry): string {
  return `${entry.min} <= versão <= ${entry.max}`;
}

function approvalDirOf(policy: unknown): string {
  const dir = asRecord(policy)?.approvalsDir;
  return typeof dir === "string" && dir.trim() !== "" ? dir : "scripts/dependency-approvals";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

/** `0.31.10-rc.1` -> `0.31.10`; `10.0.0` -> `10.0.0`. */
function baseOf(version: string): string {
  return version.split("-", 1)[0];
}

function toTriple(version: string): [number, number, number] {
  const parts = baseOf(String(version)).split(".");
  const read = (index: number): number => {
    const parsed = Number.parseInt(parts[index] ?? "0", 10);
    return Number.isFinite(parsed) ? parsed : 0;
  };
  return [read(0), read(1), read(2)];
}

// ---------------------------------------------------------------------------------------
// CLI — daqui para baixo é I/O puro. O núcleo acima não conhece `fs`, `git` nem `cwd`.
// ---------------------------------------------------------------------------------------

/** Razão de precondição usada quando a política não pôde ser lida ou não é um objeto. */
export const PRECONDICAO_POLITICA = "politica ausente ou malformada";

/** Escreve o relatório JSON e devolve o código de saída. Quem chama decide se sai ou propaga. */
function emitir(
  status: "pass" | "fail",
  exitCode: 0 | 1 | 2,
  payload: Record<string, unknown>,
): 0 | 1 | 2 {
  const reasons = Array.isArray(payload.reasons) ? (payload.reasons as string[]) : [];
  // Os findings informativos vão em campo próprio: somem de `reasons` (não bloqueiam) mas precisam
  // aparecer no relatório, senão um rebaixamento de `high`/`medium` seria invisível no stdout.
  const informative = Array.isArray(payload.informative) ? (payload.informative as string[]) : [];
  process.stdout.write(
    JSON.stringify(
      {
        schema: "upgrade-guard/1",
        ok: status === "pass",
        status,
        generatedAt: new Date().toISOString(),
        repo: payload.repo ?? process.cwd(),
        observed: payload.observed ?? {},
        checks: payload.checks ?? [],
        reasons,
        informative,
        hint:
          payload.hint ??
          "npm run guard:upgrade; downgrade de pacote critical exige Downgrade Request em scripts/dependency-approvals",
      },
      null,
      2,
    ) + "\n",
  );
  return exitCode;
}

/** Precondição: sai com `2` e nunca é `pass`. Levanta para o `runCli` fechar o veredito. */
class PreconditionError extends Error {
  readonly observed: Record<string, unknown>;

  constructor(reason: string, observed: Record<string, unknown>) {
    super(reason);
    this.name = "PreconditionError";
    this.observed = observed;
  }
}

function precondicao(reason: string, observed: Record<string, unknown>): never {
  throw new PreconditionError(reason, observed);
}

function localizarRaiz(): string {
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top !== "") return top;
  } catch {
    /* git indisponível: precondição tratada abaixo */
  }
  return process.cwd();
}

function lerJson(file: string, rotulo: string): unknown {
  let raw: string;
  try {
    raw = readFileSync(file, "utf8");
  } catch {
    precondicao(`${rotulo} ausente ou ilegível (${file})`, { arquivo: file });
  }
  try {
    return JSON.parse(raw);
  } catch {
    precondicao(`${rotulo} com JSON malformado (${file})`, { arquivo: file });
  }
}

function coletarSpecs(pkg: unknown): Record<string, string> {
  const record = asRecord(pkg);
  const out: Record<string, string> = {};
  for (const bloco of ["dependencies", "devDependencies"]) {
    const deps = asRecord(record?.[bloco]);
    if (!deps) continue;
    for (const [name, spec] of Object.entries(deps)) {
      if (typeof spec === "string") out[name] = spec;
    }
  }
  return out;
}

function coletarResolvidos(lock: unknown): Record<string, string> {
  const packages = asRecord(asRecord(lock)?.packages);
  const out: Record<string, string> = {};
  for (const [chave, entrada] of Object.entries(packages ?? {})) {
    if (!chave.startsWith("node_modules/")) continue;
    const nome = chave.slice("node_modules/".length);
    const version = asRecord(entrada)?.version;
    if (typeof nome === "string" && typeof version === "string") out[nome] = version;
  }
  return out;
}

function coletarHeadSpecs(root: string): Record<string, string> {
  try {
    const raw = execFileSync("git", ["show", "HEAD:package.json"], {
      encoding: "utf8",
      cwd: root,
      stdio: ["ignore", "pipe", "ignore"],
    });
    return coletarSpecs(JSON.parse(raw));
  } catch {
    // Sem HEAD legível (clone raso, repo sem commit, git fora): a comparação de rebaixamento
    // simplesmente não roda e o check sai `skip` nomeado. Não é `pass`, e não é precondição.
    return {};
  }
}

function coletarInstalados(root: string, entries: readonly PolicyEntry[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const entry of entries) {
    const manifest = path.join(root, "node_modules", entry.name, "package.json");
    if (!existsSync(manifest)) continue;
    try {
      const version = asRecord(JSON.parse(readFileSync(manifest, "utf8")))?.version;
      if (typeof version === "string") out[entry.name] = version;
    } catch {
      // Manifesto de instalação ilegível: tratado como ausente (skip nomeado), nunca presumido.
    }
  }
  return out;
}

function coletarAprovacoes(dir: string): string[] {
  if (!existsSync(dir)) return [];
  try {
    return readdirSync(dir).filter((nome) => nome.endsWith(".json"));
  } catch {
    return [];
  }
}

/**
 * Executa o guard contra a árvore real e DEVOLVE o código de saída (0 pass, 1 violação,
 * 2 precondição). Quem chama decide se sai ou propaga — assim o teste pode afirmar o código sem
 * matar o processo do runner.
 */
export function runCli(cwd: string = process.cwd()): 0 | 1 | 2 {
  const anterior = process.cwd();
  try {
    try {
      process.chdir(cwd);
    } catch {
      precondicao(`diretório de trabalho inacessível (${cwd})`, { cwd });
    }
    const root = localizarRaiz();
    try {
      process.chdir(root);
    } catch {
      precondicao(`raiz do repositório inacessível (${root})`, { root });
    }

    const policyFile = path.join(root, "scripts", "dependency-policy.json");
    if (!existsSync(policyFile))
      precondicao(PRECONDICAO_POLITICA, { policyFile, motivo: "arquivo ausente" });
    const policy = lerJson(policyFile, "scripts/dependency-policy.json");
    if (!asRecord(policy))
      precondicao(PRECONDICAO_POLITICA, { policyFile, motivo: "não é objeto" });

    const pkgFile = path.join(root, "package.json");
    const lockFile = path.join(root, "package-lock.json");
    if (!existsSync(pkgFile)) precondicao("package.json ausente ou ilegível", { arquivo: pkgFile });
    if (!existsSync(lockFile))
      precondicao("package-lock.json ausente ou ilegível", { arquivo: lockFile });
    const pkg = lerJson(pkgFile, "package.json");
    const lock = lerJson(lockFile, "package-lock.json");

    // As entradas que passam na estrutura são necessárias ANTES do I/O restante: só elas dizem
    // quais `node_modules/<nome>/package.json` ler. A varredura completa vem depois, com tudo lido.
    const input: AuditInput = {
      policy,
      specs: coletarSpecs(pkg),
      lockResolved: coletarResolvidos(lock),
      installed: coletarInstalados(root, readPolicyEntries(policy)),
      headSpecs: coletarHeadSpecs(root),
      approvals: coletarAprovacoes(path.join(root, approvalDirOf(policy))),
    };
    const final = runAudit(input);
    const reasons = final.findings.filter(isBlockingFinding);
    const informative = final.findings.filter((achado) => !isBlockingFinding(achado));
    const observed = {
      policySchema: asRecord(policy)?.schema ?? null,
      policyPackages: final.entries.length,
      approvalsDir: approvalDirOf(policy),
      approvals: input.approvals.length,
      specs: Object.keys(input.specs).length,
      lockResolved: Object.keys(input.lockResolved).length,
      installed: Object.keys(input.installed).length,
      headSpecs: Object.keys(input.headSpecs).length,
    };
    if (reasons.length === 0)
      return emitir("pass", 0, {
        repo: root,
        observed,
        checks: final.checks,
        reasons: [],
        informative,
      });
    return emitir("fail", 1, { repo: root, observed, checks: final.checks, reasons, informative });
  } catch (err) {
    if (!(err instanceof PreconditionError)) throw err;
    return emitir("fail", 2, {
      observed: err.observed,
      checks: [{ id: "precondition", status: "fail", detail: err.message }],
      reasons: [err.message],
    });
  } finally {
    try {
      process.chdir(anterior);
    } catch {
      /* restaura best-effort; o veredito já está no stdout */
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  process.exit(runCli());
}
