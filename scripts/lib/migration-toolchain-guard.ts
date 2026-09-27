/**
 * migration-toolchain-guard — guard de política da toolchain de migration (drizzle-kit).
 *
 * Existe por causa de um incidente real: um WIP rebaixou `drizzle-kit` de
 * `^0.31.10` para `^0.18.1`, e a 0.18.1 é **anterior ao símbolo `defineConfig`**,
 * que `drizzle.config.ts:1` importa. O sintoma apareceu tarde, no `tsc`:
 *
 *     drizzle.config.ts(1,10): error TS2305
 *
 * Este guard pega isso antes, sem banco e sem rede. Ele é o **check específico**
 * de migration toolchain; o `scripts/lib/upgrade-guard.ts` é o **check geral** de
 * política de dependências. Os dois se complementam: o upgrade-guard é o portão de
 * entrada, este é a checagem derivada do caso de maior consequência.
 *
 * Divisão núcleo/I/O (deliberada):
 *   - núcleo puro: `auditMigrationToolchain(input)` recebe **dados já lidos** e
 *     devolve `string[]` de findings. Sem `fs`, sem rede, sem banco — testável
 *     hermeticamente (um teste que precise de um segundo `node_modules` para
 *     falsificar não é hermético);
 *   - CLI: faz o I/O e chama o núcleo.
 *
 * Códigos de saída: 0 = pass · 1 = veredito (violação) · 2 = precondição
 * (política ausente/malformada, `drizzle.config.ts` ilegível). Precondição nunca
 * é `pass`. Mesma convenção de `scripts/m02-lockfile-guard.mjs`.
 *
 * Formato da finding (contrato compartilhado com o upgrade-guard):
 *   `${pacote} (${lado}): observado ${observado}, esperado ${esperado}`
 */

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import type { MigrationClass } from "../db/migration-classes";
import { MIGRATION_CLASSES, migrationClasses } from "../db/migration-classes";

/**
 * Pacote sob política. `drizzle-kit` é `critical` em
 * `scripts/dependency-policy.json` porque INV-012 (migrations reproduzíveis)
 * depende dele e porque `drizzle.config.ts` importa um símbolo que só existe a
 * partir de uma certa versão.
 */
const PKG = "drizzle-kit";

/** Faixa da política; lida de `scripts/dependency-policy.json`, nunca hardcoded. */
const POLICY_FILE = path.join("scripts", "dependency-policy.json");

/** Contrato do `drizzle.config.ts` — o `out` é onde o Drizzle escreve as migrations. */
const EXPECTED_DIALECT = "postgresql";
const EXPECTED_OUT = "./drizzle";

/**
 * §12.2 do plano separa pooled (runtime) de direct (migration). Sem as duas
 * declaradas, alguém aplica migration por conexão pooled em transaction mode.
 */
const REQUIRED_ENV = ["DATABASE_URL", "DATABASE_ADMIN_URL"] as const;

/** Símbolo importado por `drizzle.config.ts:1`. */
const REQUIRED_SYMBOL = "defineConfig";

/**
 * URL dummy **loopback**. `defineConfig` só valida o objeto recebido; o módulo
 * não abre conexão. O guard é propositalmente sem banco para rodar no pipeline
 * leve — conectividade real fica no tier `db:test`, que exige container PG17.
 */
const DUMMY_ADMIN_URL = "postgresql://postgres:postgres@127.0.0.1:5432/preco_que_da_lucro_test";

// ---------------------------------------------------------------------------
// Comparação de versão (deliberadamente duplicada — ver comentário abaixo)
// ---------------------------------------------------------------------------

/**
 * NOTA DE ACOPLAMENTO (deliberada): `compareVersions`/`inRange` existem aqui e
 * também no `scripts/lib/upgrade-guard.ts`, com o mesmo formato e as mesmas
 * assinaturas. São ~20 linhas de aritmética. Não as importe de lá: um guard de
 * política não pode falhar porque o outro arquivo foi movido ou renomeado, e
 * nenhum dos dois deve poder quebrar o outro. Se um dia a duplicação custar caro,
 * extraia para `scripts/lib/version-compare.ts` — decisão do MAESTRO, não nossa.
 */
const VERSION_RE = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/;

function parseVersion(value: string): [number, number, number] | null {
  const m = VERSION_RE.exec(String(value ?? "").trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}

/**
 * Compara `major.minor.patch` numericamente; pre-release e build metadata são
 * ignorados (`0.31.10-rc.1` === `0.31.10`). Retorna `-1 | 0 | 1`.
 * Versão ilegível ordena depois de qualquer versão legível (fail-closed: um typo
 * no `min` não pode fazer o guard "aprovar").
 */
export function compareVersions(a: string, b: string): number {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) {
    if (!pa && !pb) return 0;
    return pa ? 1 : -1;
  }
  for (let i = 0; i < 3; i += 1) {
    if (pa[i] !== pb[i]) return pa[i] < pb[i] ? -1 : 1;
  }
  return 0;
}

/** `min` e `max` são **inclusivos** (ver `scripts/dependency-policy.json`). */
export function inRange(version: string, min: string, max: string): boolean {
  if (!parseVersion(version) || !parseVersion(min) || !parseVersion(max)) return false;
  return compareVersions(version, min) >= 0 && compareVersions(version, max) <= 0;
}

// ---------------------------------------------------------------------------
// Núcleo puro
// ---------------------------------------------------------------------------

export interface PolicyPackage {
  name?: string;
  criticality?: string;
  min?: string;
  max?: string;
  reason?: string;
}

export interface PolicyFile {
  schema?: string;
  policy?: string;
  approvalsDir?: string;
  packages?: PolicyPackage[];
}

export interface DrizzleConfigShape {
  dialect: string;
  out: string;
  schema: string;
}

export interface MigrationScan {
  file: string;
  classificada: boolean;
  classificacao: string | null;
}

export interface MigrationToolchainInput {
  /** `min` da política para `drizzle-kit` (string vazia = pacote ausente). */
  policyMin: string;
  /** `max` da política para `drizzle-kit` (string vazia = pacote ausente). */
  policyMax: string;
  /** `.version` de `node_modules/drizzle-kit/package.json`. */
  installedVersion: string | null;
  /** Conteúdo do `.d.ts` que declara os exports de `drizzle-kit`. */
  typesText: string | null;
  /** `drizzle.config.ts` já carregado, ou `null`. */
  configModule: DrizzleConfigShape | null;
  /** Mensagem do erro de load, quando houver. */
  configError: string | null;
  /** `drizzle/*.sql` varridos, com a classificação vindo do registry. */
  migrations: MigrationScan[];
  /** Nomes de env declarados em `.env.example` (sem valores). */
  envNames: string[];
}

const finding = (pkg: string, side: string, observed: string, expected: string): string =>
  `${pkg} (${side}): observado ${observed}, esperado ${expected}`;

/**
 * Auditoria fail-closed. Ausência é violação: política sem o pacote, pacote
 * listado e não instalado, faixa degenerada, tipos ausentes, config que não
 * carrega, descoberta de migrations vazia, env por declarar.
 */
export function auditMigrationToolchain(input: MigrationToolchainInput): string[] {
  const findings: string[] = [];
  const { policyMin, policyMax } = input;
  const range = `${policyMin}..${policyMax}`;

  // 1. Faixa da política: o pacote precisa existir e a faixa precisa ser válida.
  const minParsed = parseVersion(policyMin);
  const maxParsed = parseVersion(policyMax);
  if (!minParsed || !maxParsed) {
    findings.push(
      finding(
        PKG,
        "policy",
        `entrada ausente ou com min/max ilegível (min='${policyMin}', max='${policyMax}')`,
        `entrada em ${POLICY_FILE} com min e max em major.minor.patch`,
      ),
    );
  } else if (compareVersions(policyMin, policyMax) >= 0) {
    findings.push(
      finding(
        PKG,
        "policy",
        `faixa degenerada min='${policyMin}' max='${policyMax}'`,
        "min < max (faixa não vazia e não invertida)",
      ),
    );
  }

  // 2. Versão instalada dentro da faixa aprovada. Downgrade e "acima da faixa"
  //    são mensagens diferentes: é o que torna o diagnóstico acionável.
  if (input.installedVersion === null) {
    findings.push(
      finding(
        PKG,
        "installed",
        "ausente (toolchain não instalada em node_modules)",
        `versão em node_modules/${PKG}/package.json dentro de ${range}`,
      ),
    );
  } else if (!minParsed || !maxParsed) {
    findings.push(
      finding(
        PKG,
        "installed",
        `${input.installedVersion} (faixa da política ilegível, faixa não verificável)`,
        `versão dentro de ${range}`,
      ),
    );
  } else if (compareVersions(input.installedVersion, policyMin) < 0) {
    findings.push(
      finding(
        PKG,
        "installed",
        input.installedVersion,
        `>=${policyMin} (downgrade abaixo do mínimo aprovado ${range})`,
      ),
    );
  } else if (compareVersions(input.installedVersion, policyMax) > 0) {
    findings.push(
      finding(
        PKG,
        "installed",
        input.installedVersion,
        `<=${policyMax} (fora da faixa aprovada ${range})`,
      ),
    );
  }

  // 3. O símbolo importado por drizzle.config.ts precisa existir na toolchain.
  //    Este é o teste que falsifica o incidente real (0.18.1 sem defineConfig).
  if (input.typesText === null) {
    findings.push(
      finding(
        PKG,
        "types",
        "arquivo de tipos não encontrado em node_modules",
        `declaração de ${REQUIRED_SYMBOL} nos tipos de ${PKG}`,
      ),
    );
  } else if (!input.typesText.includes(REQUIRED_SYMBOL)) {
    findings.push(
      finding(
        PKG,
        "types",
        `tipos sem ${REQUIRED_SYMBOL}`,
        `${REQUIRED_SYMBOL} declarado — a versão instalada é anterior ao símbolo importado por drizzle.config.ts`,
      ),
    );
  }

  // 4. drizzle.config.ts carrega e aponta para o destino do contrato.
  if (input.configError !== null) {
    findings.push(
      finding(
        PKG,
        "drizzle.config.ts",
        `erro ao carregar: ${input.configError}`,
        "config carregável (defineConfig presente e objeto válido)",
      ),
    );
  } else if (input.configModule === null) {
    findings.push(
      finding(
        PKG,
        "drizzle.config.ts",
        "módulo sem default export",
        "default export de drizzle.config.ts",
      ),
    );
  } else {
    if (input.configModule.dialect !== EXPECTED_DIALECT) {
      findings.push(
        finding(
          PKG,
          "drizzle.config.ts",
          `dialect='${input.configModule.dialect}'`,
          `dialect='${EXPECTED_DIALECT}'`,
        ),
      );
    }
    if (input.configModule.out !== EXPECTED_OUT) {
      findings.push(
        finding(
          PKG,
          "drizzle.config.ts",
          `out='${input.configModule.out}'`,
          `out='${EXPECTED_OUT}'`,
        ),
      );
    }
  }

  // 5. Migrations classificadas. Taxonomia reutilizada de
  //    scripts/db/migration-classes.ts — não reimplementada.
  if (input.migrations.length === 0) {
    findings.push(
      finding(
        "drizzle",
        "migrations",
        "0 arquivos em drizzle/*.sql",
        "ao menos uma migration classificada (descoberta vazia não é aprovação)",
      ),
    );
  }
  for (const m of input.migrations) {
    if (!m.classificada) {
      findings.push(
        finding(
          "drizzle",
          "migrations",
          `${m.file} sem classificação`,
          "entrada classificada em scripts/db/migration-classes.ts",
        ),
      );
      continue;
    }
    const classificacao = m.classificacao as string;
    if (!MIGRATION_CLASSES.includes(classificacao as MigrationClass)) {
      findings.push(
        finding(
          "drizzle",
          "migrations",
          `${m.file} com classificação '${m.classificacao}' fora da taxonomia`,
          `uma de ${MIGRATION_CLASSES.join(", ")}`,
        ),
      );
    }
  }

  // 6. Ambiente declarado: pooled para o runtime, direct para migration (§12.2).
  const declared = new Set(input.envNames);
  const missingEnv = REQUIRED_ENV.filter((name) => !declared.has(name));
  if (missingEnv.length > 0) {
    findings.push(
      finding(
        PKG,
        "env.example",
        `sem ${missingEnv.join(", ")} (declarados: ${input.envNames.join(", ") || "nenhum"})`,
        "DATABASE_URL (pooled, runtime) e DATABASE_ADMIN_URL (direct, migrations) declarados em .env.example",
      ),
    );
  }

  return findings;
}

// ---------------------------------------------------------------------------
// CLI — todo o I/O mora aqui
// ---------------------------------------------------------------------------

type CheckStatus = "pass" | "fail" | "skip";
interface Check {
  id: string;
  status: CheckStatus;
  detail: string;
}

const EXIT_OK = 0;
const EXIT_VERDICT = 1;
const EXIT_PRECONDITION = 2;

function emit(
  exitCode: number,
  observed: Record<string, unknown>,
  checks: Check[],
  precondition: string | null,
): never {
  const ok = exitCode === EXIT_OK;
  const status =
    exitCode === EXIT_OK ? "pass" : exitCode === EXIT_VERDICT ? "fail" : "precondition";
  const reasons = checks.filter((c) => c.status === "fail").map((c) => `${c.id}: ${c.detail}`);
  process.stdout.write(
    JSON.stringify(
      {
        schema: "migration-toolchain-guard/1",
        ok,
        status,
        generatedAt: new Date().toISOString(),
        repo: observed.repo,
        observed,
        checks,
        reasons,
        hint: "Restaure a faixa aprovada em scripts/dependency-policy.json, rode `npm ci --ignore-scripts` e reexecute o guard; para rebaixar de propósito, abra Downgrade Request com teste comparativo (docs/upgrades/MIGRATION-TOOLCHAIN-POLICY.md).",
        ...(precondition ? { precondition } : {}),
      },
      null,
      2,
    ) + "\n",
  );
  process.exit(exitCode);
}

function preconditionFail(reason: string, observed: Record<string, unknown>): never {
  emit(
    EXIT_PRECONDITION,
    observed,
    [{ id: "precondition", status: "fail", detail: `[precondição] ${reason}` }],
    reason,
  );
}

function readJson(file: string): unknown {
  return JSON.parse(readFileSync(file, "utf8")) as unknown;
}

/** Localiza o pacote na política; string vazia quando ausente. */
function policyRange(policy: PolicyFile): {
  min: string;
  max: string;
  entry: PolicyPackage | null;
} {
  const packages = Array.isArray(policy?.packages) ? policy.packages : [];
  const entry = packages.find((p) => p?.name === PKG) ?? null;
  return { min: entry?.min ?? "", max: entry?.max ?? "", entry };
}

/**
 * Resolve o arquivo de tipos de `drizzle-kit`: campo `types`/`typings` quando
 * declarado; senão o `types` do `exports["."]` (o drizzle-kit 0.31.x publica por
 * `exports` e não tem `types` no topo); senão os fallbacks usuais.
 */
function resolveTypesPath(root: string, manifest: Record<string, unknown> | null): string | null {
  const base = path.join(root, "node_modules", PKG);
  const rootExport = (manifest?.exports as Record<string, unknown> | undefined)?.["."] as
    Record<string, unknown> | undefined;
  const declared = [
    manifest?.types,
    manifest?.typings,
    rootExport?.types,
    (rootExport?.import as Record<string, unknown> | undefined)?.types,
    (rootExport?.require as Record<string, unknown> | undefined)?.types,
  ];
  const candidates = [
    ...declared.filter((c): c is string => typeof c === "string"),
    "dist/index.d.ts",
    "index.d.mts",
    "index.d.ts",
  ];
  for (const candidate of candidates) {
    const full = path.join(base, candidate);
    if (existsSync(full)) return full;
  }
  return null;
}

/** Varre `drizzle/*.sql` e classifica pelo registry sidecar (tag sem extensão). */
function scanMigrations(root: string): MigrationScan[] {
  const dir = path.join(root, "drizzle");
  if (!existsSync(dir)) return [];
  const byTag = new Map(migrationClasses.map((e) => [e.tag, e]));
  return readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort()
    .map((file) => {
      const tag = file.replace(/\.sql$/, "");
      const entry = byTag.get(tag);
      return {
        file: `drizzle/${file}`,
        classificada: Boolean(entry),
        classificacao: entry?.class ?? null,
      };
    });
}

/** Nomes de env declarados em `.env.example` — nunca os valores. */
function readEnvNames(root: string): string[] {
  const file = path.join(root, ".env.example");
  if (!existsSync(file)) return [];
  const names: string[] = [];
  for (const line of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = /^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/.exec(line);
    if (m) names.push(m[1]);
  }
  return names;
}

interface ConfigLoad {
  module: DrizzleConfigShape | null;
  error: string | null;
}

/** Carrega `drizzle.config.ts` com URL admin dummy. Nenhuma conexão é aberta. */
async function loadDrizzleConfig(root: string): Promise<ConfigLoad> {
  const previous = process.env.DATABASE_ADMIN_URL;
  process.env.DATABASE_ADMIN_URL = DUMMY_ADMIN_URL;
  try {
    const href = pathToFileURL(path.join(root, "drizzle.config.ts")).href;
    const mod = (await import(`${href}?guard=${Date.now()}`)) as Record<string, unknown>;
    const def = (mod.default ?? null) as Partial<DrizzleConfigShape> | null;
    if (!def || typeof def !== "object") return { module: null, error: null };
    return {
      module: {
        dialect: String(def.dialect ?? ""),
        out: String(def.out ?? ""),
        schema: String(def.schema ?? ""),
      },
      error: null,
    };
  } catch (err) {
    return { module: null, error: err instanceof Error ? err.message : String(err) };
  } finally {
    if (previous === undefined) delete process.env.DATABASE_ADMIN_URL;
    else process.env.DATABASE_ADMIN_URL = previous;
  }
}

export async function main(): Promise<never> {
  let root = process.cwd();
  try {
    const top = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (top) root = top;
  } catch {
    preconditionFail("git indisponível: não foi possível localizar a raiz do repositório", {
      repo: root,
    });
  }

  const policyPath = path.join(root, POLICY_FILE);
  if (!existsSync(policyPath)) {
    preconditionFail(`política de dependências ausente (${POLICY_FILE})`, { repo: root });
  }
  let policy: PolicyFile;
  try {
    policy = readJson(policyPath) as PolicyFile;
  } catch (err) {
    preconditionFail(
      `política de dependências malformada (${POLICY_FILE}): ${err instanceof Error ? err.message : String(err)}`,
      { repo: root },
    );
  }
  const { min, max, entry } = policyRange(policy);
  if (!entry) {
    preconditionFail(`${PKG} ausente da política de dependências (${POLICY_FILE})`, { repo: root });
  }

  const configPath = path.join(root, "drizzle.config.ts");
  if (!existsSync(configPath)) {
    preconditionFail("drizzle.config.ts ilegível: arquivo ausente", { repo: root });
  }

  const manifestPath = path.join(root, "node_modules", PKG, "package.json");
  let manifest: Record<string, unknown> | null = null;
  let installedVersion: string | null = null;
  if (existsSync(manifestPath)) {
    try {
      manifest = readJson(manifestPath) as Record<string, unknown>;
      const v = manifest.version;
      installedVersion = typeof v === "string" ? v : null;
    } catch (err) {
      manifest = null;
      installedVersion = null;
      process.stderr.write(
        `[migration-toolchain-guard] manifest de ${PKG} ilegível: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
  }

  const typesPath = manifest ? resolveTypesPath(root, manifest) : null;
  const typesText = typesPath ? readFileSync(typesPath, "utf8") : null;
  const migrations = scanMigrations(root);
  const envNames = readEnvNames(root);
  const { module: configModule, error: configError } = await loadDrizzleConfig(root);

  const observed: Record<string, unknown> = {
    repo: root,
    policyMin: min,
    policyMax: max,
    criticality: entry.criticality ?? null,
    installedVersion,
    typesPath: typesPath ? path.relative(root, typesPath) : null,
    typesDeclaresDefineConfig: typesText === null ? null : typesText.includes(REQUIRED_SYMBOL),
    dialect: configModule?.dialect ?? null,
    out: configModule?.out ?? null,
    configError,
    migrationsFound: migrations.length,
    migrationsClassified: migrations.filter((m) => m.classificada).length,
    unclassified: migrations.filter((m) => !m.classificada).map((m) => m.file),
    envNames,
    requiredEnv: [...REQUIRED_ENV],
  };

  const findings = auditMigrationToolchain({
    policyMin: min,
    policyMax: max,
    installedVersion,
    typesText,
    configModule,
    configError,
    migrations,
    envNames,
  });

  const checks: Check[] = findings.map((detail, i) => ({
    id: `migration-toolchain-${i + 1}`,
    status: "fail",
    detail,
  }));
  if (checks.length === 0) {
    checks.push({
      id: "migration-toolchain",
      status: "pass",
      detail: `toolchain ${installedVersion} na faixa ${min}..${max}; defineConfig presente; ${migrations.length} migration(s) classificadas; env declarado`,
    });
  }
  emit(checks.some((c) => c.status === "fail") ? EXIT_VERDICT : EXIT_OK, observed, checks, null);
}

const entrypoint = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === entrypoint) {
  await main();
}
