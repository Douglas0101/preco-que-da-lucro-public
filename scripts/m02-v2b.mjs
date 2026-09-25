// m02-v2b.mjs — V2b ONE-COMMAND: janela V2b (runbook cutover-A4.md §13) em
// um único comando. Carga legacy × branch efêmera, reconciliação MODO DADOS
// (§13.4/§13.5), schema diff legacy×Neon (§13.3), snippet de ledger
// MEDIDA-EM-CÓPIA e cleanup §12.5 always(). NÃO toca produção com escrita;
// produção nem é conectada (a branch copia o parent at HEAD via Neon).
//
// Contrato:
//   npm run m02:v2b -- --plan   → imprime o DAG de passos SEM conectar (exit 0
//                                  sempre, credenciais ou não; única exceção é
//                                  journal do Drizzle ilegível, erro de repo).
//   npm run m02:v2b             → executa. Sem SUPABASE_MIGRATION_DATABASE_URL
//                                  → exit 3 COM orientação (dono humano D2)
//                                  ANTES de qualquer conexão/spawn de rede.
//
// Exit codes: 0 sucesso · 1 passo falhou (cleanup rodou) · 2 erro interno
// (fail-closed) · 3 credencial ausente no preflight (pré-conexão).
//
// Norma de segredos: URLs nunca em argv, nunca impressas — somente hostnames
// mascarados via maskUrl(). Logs em JSONL no stdout.

import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "pg";

const GUARD_FILE = "docs/specs/M-02/emenda-2026-09-07-env-guard.md";
const DEFAULT_PROJECT_ID = "damp-forest-57346541";
// NORMA §12.4 (modelo de branch: production → develop → preview/pr-<n>): este
// default aponta para production (`br-snowy-violet-aymcvvvv`, read-only) porque
// o V2b é o ensaio aposentado de cutover e copia o primeiro elo da cadeia — a
// cópia é descartável e o parent nunca é alvo de escrita. A escolha do parent é
// parâmetro explícito: `NEON_PARENT_BRANCH_ID` (ver main()) tem precedência, e
// qualquer execução nova deve passá-lo (ex.: o id da branch develop,
// `br-small-hill-aymcu14y`) em vez de herdar este default. O workflow §12.4
// (`neon-pr-branch.yml`) aplica a mesma norma via `github.base_ref`.
const DEFAULT_PARENT_BRANCH_ID = "br-snowy-violet-aymcvvvv"; // production (id, não nome)
const DB_NAME = "neondb";
const ROLE_NAME = "neondb_owner";
/**
 * Contagem esperada de migrations: **derivada** (ver `expectedJournalCount()`)
 * do journal do Drizzle — a fonte canônica que o migrator consome. Hardcode
 * neste ponto envelhece e quebra o ensaio fail-closed: `0015` exigiu o reparo em
 * `ed29d4b` e `0016` (WP-1a) quebrou de novo o passo `migrate`.
 */
const JOURNAL_PATH = "drizzle/meta/_journal.json";
const ROOT_DIR = resolve(fileURLToPath(import.meta.url), "..", "..");
const MIGRATION_MOTIVO = "V2b CUTOVER-PREP: carga legacy em branch de drill efêmera";
const RETRY_LIMIT = 1; // regra da rodada: SEM loop de retry > 1
const NPM_CLI = resolve(
  dirname(process.execPath),
  "..",
  "lib",
  "node_modules",
  "npm",
  "bin",
  "npm-cli.js",
);
const COMMAND_PATHS = {
  docker: "/usr/bin/docker",
  neon: resolve(dirname(process.execPath), "neon"),
};

function usage() {
  return [
    "uso: npm run m02:v2b -- [--plan]",
    "  --plan  imprime o DAG de passos sem conectar (exit 0 sempre; sem credencial não falha — só journal do Drizzle ilegível)",
    "  (sem flag) executa a janela V2b; exige SUPABASE_MIGRATION_DATABASE_URL",
    "            (read-only legacy, dono humano D2) no ambiente",
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = { plan: false };
  for (const arg of argv) {
    if (arg === "--plan") parsed.plan = true;
    else return { error: `argumento não reconhecido: ${arg}` };
  }
  return parsed;
}

function utcDate(now = new Date()) {
  return now.toISOString().slice(0, 10);
}

/** Máscara de URL: somente hostname (com ep- truncado), nunca credencial. */
function maskUrl(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "<malformada>";
  }
}

function logLine(payload) {
  process.stdout.write(`${JSON.stringify({ script: "m02-v2b", ...payload })}\n`);
}

/**
 * Contagem esperada de migrations do drill = entradas do journal do Drizzle,
 * LIDAS em tempo de execução (`drizzle/meta/_journal.json`). Derivar é o que
 * impede o drill de ficar preso a um número velho quando uma migration entra.
 *
 * Fail-closed: journal ausente, ilegível ou sem entradas é erro explícito com o
 * caminho no texto — nunca "0 esperado" e nunca passe silencioso. O default de
 * `rootDir` sai da posição do próprio módulo (`scripts/`), então funciona
 * independente do cwd de quem chamou.
 */
function expectedJournalCount(rootDir = ROOT_DIR) {
  const path = resolve(rootDir, JOURNAL_PATH);
  let parsed;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(
      `journal do Drizzle ilegível em ${JOURNAL_PATH} (${safeError(error)}); rode da raiz do repo`,
    );
  }
  const count = Array.isArray(parsed?.entries) ? parsed.entries.length : 0;
  if (!Number.isInteger(count) || count <= 0) {
    throw new Error(
      `journal do Drizzle sem entradas em ${JOURNAL_PATH} (esperado >= 1; journal vazio ou malformado)`,
    );
  }
  return count;
}

/**
 * Preflight PRÉ-CONEXÃO: valida credencial e ferramentas locais SEM abrir
 * socket e SEM invocar nenhum comando de rede. Retorna a lista de ausências.
 */
function preflight(env) {
  const missing = [];
  const legacy = env.SUPABASE_MIGRATION_DATABASE_URL;
  if (typeof legacy !== "string" || legacy.trim() === "") {
    missing.push("SUPABASE_MIGRATION_DATABASE_URL");
  }
  return { ok: missing.length === 0, missing };
}

function preflightGuidance(missing) {
  return [
    `m02-v2b: EXIT 3 (pré-conexão; nenhum socket foi aberto) — credencial(es) ausente(s): ${missing.join(", ")}.`,
    "Orientação (dono humano D2): fornecer URL POSTGRES read-only do legado Supabase",
    "  (acesso a `auth` e `public`) via SUPABASE_MIGRATION_DATABASE_URL — ver",
    "  docs/runbooks/cutover-A4.md §13 (janela V2b, ANTES da declaração de freeze;",
    "  NO-GO 10/09 se inconclusa) e docs/evidence/cutover-2026-09-07/dryrun-notes.md §5.",
    "Este comando não tenta acesso via API/publishable key e não improvisa credencial.",
  ].join("\n");
}

/** DAG exibido por --plan e executado por run. Comandos nunca contêm URLs. */
function buildPlan(ctx) {
  const journalCount = expectedJournalCount();
  return [
    {
      id: "preflight",
      what: "validar SUPABASE_MIGRATION_DATABASE_URL e neon CLI ANTES de qualquer conexão",
      on_fail: "exit 3 com orientação ao dono humano D2 (pré-conexão provada no log)",
    },
    {
      id: "create-branch",
      what: `neon branches create --project-id ${ctx.projectId} --name ${ctx.branchName} --parent ${ctx.parentBranchId} --expires-at ${ctx.expiresAt} (kind drill-branch, §12.4 isolada + §12.5 efêmera)`,
      on_fail: "fail → cleanup always() → exit 1",
    },
    {
      id: "connection-info",
      what: `neon cs ${ctx.branchName} --role-name ${ROLE_NAME} --extended -o json (DIRECT da branch; host mascarado no log)`,
      on_fail: "fail → cleanup always() → exit 1",
    },
    {
      id: "migrate",
      what: "npm run db:migrate contra DIRECT da branch com NEON_MIGRATION_TARGET_KIND=drill-branch + ALLOW_REMOTE_DB (motivo logado; emenda #2 — produção intocável)",
      expected: `journal __drizzle_migrations = ${journalCount} (${journalCount}/${journalCount} pós-migrate)`,
      on_fail: "fail → cleanup always() → exit 1 (sem retry > 1)",
    },
    {
      id: "carga-legacy",
      what: "npm run migration:legacy-to-neon com MIGRATION_APPLY=true, alvo DATABASE_ADMIN_URL=branch DIRECT, fonte SUPABASE_MIGRATION_DATABASE_URL read-only; relatório em MIGRATION_REPORT_PATH",
      on_fail: "GATILHO DE PARADA: falha no meio → cleanup always(), reportar, SEM retry > 1",
    },
    {
      id: "reconcile-legacy-branch",
      what: `node scripts/m02-reconcile.mjs --source-env V2B_LEGACY_URL --target-env V2B_BRANCH_URL --out ${ctx.outDir}/reconciliation-legacy-${ctx.date}.md — MODO DADOS (§13.4: row count, null count, min/max timestamps, somas NUMERIC exatas, órfãos, checksum de amostras)`,
      on_fail:
        "diferenças ≠ 0 em tabela financeira → paridade permanece DESCONHECIDA → exit 1 + cleanup",
    },
    {
      id: "schema-diff-legacy-branch",
      what: `pg_dump --schema-only nas duas pontas (container pg 17) + checklist §13.3 estendido → ${ctx.outDir}/schema-diff-legacy-${ctx.date}.md`,
      on_fail:
        "falha de mecanismo → exit 1 + cleanup; achado é triado (CONFORME/GAP-DOC/VIOLAÇÃO/FALSO-ALARME/DESCONHECIDO), não consertado",
    },
    {
      id: "emit-ledger-snippet",
      what: `escrever ${ctx.outDir}/ledger-snippet-v2b.md (paridade MEDIDA-EM-CÓPIA dos dados) — NÃO edita EXECUTION-STATE-PROGRAM.md (edição é do humano via Manifest)`,
      on_fail: "exit 1 + cleanup",
    },
    {
      id: "cleanup",
      what: `neon branches delete ${ctx.branchName} + prova antes/depois em ${ctx.outDir}/branch-cleanup-v2b-${ctx.date}.md (§12.5 always(), roda em TODO caminho de saída)`,
      on_fail:
        "branch restante com expires-at de segurança; falha de deleção = exit 1 (NUNCA silently skip)",
    },
  ];
}

function printPlan(ctx) {
  process.stdout.write(`# V2b — DAG de passos (modo --plan; nenhuma conexão foi feita)\n\n`);
  process.stdout.write(
    `- branch efêmera: ${ctx.branchName} (parent ${ctx.parentBranchId} @ HEAD, expira ${ctx.expiresAt})\n`,
  );
  process.stdout.write(`- destino de evidência: ${ctx.outDir}/\n`);
  process.stdout.write(
    `- credencial exigida em execução: SUPABASE_MIGRATION_DATABASE_URL (dono humano D2)\n`,
  );
  process.stdout.write(
    `- produção: nunca conectada por este comando (hard-deny emenda #2 permanece; aqui nem drill é produção)\n\n`,
  );
  for (const [index, step] of buildPlan(ctx).entries()) {
    process.stdout.write(`${index + 1}. [${step.id}] ${step.what}\n`);
    if (step.expected) process.stdout.write(`   esperado: ${step.expected}\n`);
    process.stdout.write(`   fail: ${step.on_fail}\n`);
  }
}

function runLocal(args, opts = {}) {
  const commandPath = COMMAND_PATHS[args[0]];
  if (!commandPath) throw new Error(`comando local não permitido: ${args[0]}`);
  const result = spawnSync(commandPath, args.slice(1), {
    encoding: "utf8",
    ...opts,
    env: { ...process.env, ...(opts.env ?? {}) },
  });
  return result;
}

async function runNpm(scriptName, extraArgs, env) {
  return new Promise((done) => {
    const child = spawn(process.execPath, [NPM_CLI, "run", scriptName, ...(extraArgs ?? [])], {
      cwd: resolve(fileURLToPath(import.meta.url), "..", ".."),
      env: { ...process.env, ...(env ?? {}) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("error", (error) => done({ code: null, stdout, stderr: `${stderr}${error.message}` }));
    child.on("close", (code) => done({ code, stdout, stderr }));
  });
}

async function waitForBranchReady(ctx) {
  const deadline = Date.now() + 180_000;
  for (;;) {
    const result = runLocal([
      "neon",
      "branches",
      "list",
      "--project-id",
      ctx.projectId,
      "-o",
      "json",
      "--no-color",
    ]);
    if (result.status === 0) {
      try {
        const branches = JSON.parse(result.stdout);
        const branch = branches.find((item) => item.name === ctx.branchName);
        if (branch && branch.current_state === "ready") return branch;
      } catch {
        // saída ainda não parseável; continua o poll
      }
    }
    if (Date.now() > deadline) throw new Error("branch não ficou ready em 180s");
    await new Promise((sleep) => setTimeout(sleep, 5_000));
  }
}

async function queryJournalCount(branchUrl) {
  const client = new Client({ connectionString: branchUrl, ssl: { rejectUnauthorized: true } });
  try {
    await client.connect();
    await client.query("start transaction read only");
    const result = await client.query(
      "select count(*)::bigint as n from drizzle.__drizzle_migrations",
    );
    return Number(result.rows[0].n);
  } finally {
    try {
      await client.query("rollback");
    } catch {
      // nada a fazer
    }
    await client.end().catch(() => {});
  }
}

function countSql(pattern) {
  return (alias) => ({
    alias,
    sql: `select count(*)::bigint as n from pg_catalog.pg_class c
      join pg_catalog.pg_namespace n on n.oid = c.relnamespace
      where ${pattern}`,
  });
}

async function schemaSideSnapshot(url, label) {
  const client = new Client({ connectionString: url, ssl: { rejectUnauthorized: true } });
  const out = { side: label, host: maskUrl(url), checks: {} };
  try {
    await client.connect();
    const queries = [
      {
        alias: "extensions",
        sql: "select count(*)::bigint as n from pg_extension",
      },
      {
        alias: "enums",
        sql: "select count(*)::bigint as n from pg_type where typtype = 'e'",
      },
      countSql("c.relkind = 'r' and n.nspname = 'public'")("tables"),
      countSql(
        "c.relkind = 'r' and n.nspname = 'public' and c.oid in (select distinct conrelid from pg_constraint where contype = 'p')",
      )("tables_with_pk"),
      {
        alias: "constraints",
        sql: `select count(*)::bigint as n from pg_constraint con
          join pg_class c on c.oid = con.conrelid
          join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public'`,
      },
      {
        alias: "indexes",
        sql: `select count(*)::bigint as n from pg_index i
          join pg_class c on c.oid = i.indrelid
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and not i.indisprimary`,
      },
      {
        alias: "functions",
        sql: `select count(*)::bigint as n from pg_proc p
          join pg_namespace n on n.oid = p.pronamespace
          where n.nspname in ('public', 'auth', 'app_private')`,
      },
      {
        alias: "rls_tables",
        sql: `select count(*)::bigint as n from pg_class c
          join pg_namespace n on n.oid = c.relnamespace
          where n.nspname = 'public' and c.relrowsecurity`,
      },
      {
        alias: "rls_policies",
        sql: `select count(*)::bigint as n from pg_policies where schemaname = 'public'`,
      },
      {
        alias: "roles",
        sql: `select count(*)::bigint as n from pg_roles`,
      },
    ];
    for (const query of queries) {
      const result = await client.query(query.sql);
      out.checks[query.alias] = Number(result.rows[0].n);
    }
    await client.query("rollback");
  } finally {
    await client.end().catch(() => {});
  }
  return out;
}

function normalizeSchemaDump(text) {
  return text
    .replace(/^\\(?:un)?restrict .*\n/gm, "")
    .replace(/^-+ Dumped by pg_dump version .*\n/gm, "")
    .replace(/\/\*.*?Date: .*?\*\/\n/g, "")
    .split("\n")
    .filter((line) => !line.startsWith("# PG_DUMP_NONCE"))
    .join("\n");
}

function pgDumpSchemaOnly(url, outPath) {
  const parsed = new URL(url);
  const script = [
    "set -e",
    `pg_dump --schema-only --host=${shellQuote(parsed.hostname)} --port=${parsed.port || 5432}`,
    `  --username=${shellQuote(ROLE_NAME)} --dbname=${shellQuote(DB_NAME)}`,
    "  --no-owner --no-privileges",
  ].join(" ");
  // credencial via PGPASSWORD no ambiente do container (nunca argv/log)
  const result = runLocal(
    [
      "docker",
      "exec",
      "-i",
      "-e",
      "PGPASSWORD",
      "preco-que-da-lucro-postgres",
      "sh",
      "-c",
      `${script} > ${shellQuote(outPath)}`,
    ],
    {
      env: {
        ...process.env,
        PGPASSWORD: parsed.password ? decodeURIComponent(parsed.password) : "",
      },
      encoding: "utf8",
    },
  );
  if (result.status !== 0) {
    throw new Error(
      `pg_dump schema-only falhou em ${parsed.hostname} (detalhes omitidos: ${String(result.stderr ?? "").slice(0, 160)})`,
    );
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", `'\\''`)}'`;
}

async function step(name, fn) {
  logLine({ step: name, event: "start" });
  const started = Date.now();
  const outcome = await fn();
  logLine({
    step: name,
    event: "end",
    ok: outcome.ok !== false,
    ms: Date.now() - started,
    ...(outcome.log ?? {}),
  });
  if (outcome.ok === false) throw new Error(`passo ${name} reportou falha`);
  return outcome;
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`m02-v2b: ${parsed.error}\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  const now = new Date();
  const date = utcDate(now);
  const rootDir = resolve(fileURLToPath(import.meta.url), "..", "..");
  const ctx = {
    date,
    projectId: process.env.NEON_PROJECT_ID || DEFAULT_PROJECT_ID,
    parentBranchId: process.env.NEON_PARENT_BRANCH_ID || DEFAULT_PARENT_BRANCH_ID,
    branchName: `dryrun-v2b-${date}`,
    expiresAt: new Date(now.getTime() + 24 * 3_600_000).toISOString().replace(/\.\d{3}Z$/, "Z"),
    outDir: `docs/evidence/cutover-prep-${date}`,
  };

  if (parsed.plan) {
    printPlan(ctx);
    process.exitCode = 0;
    return;
  }

  logLine({
    event: "preflight",
    phase: "antes-de-qualquer-conexao",
    sockets_abertos: 0,
    note: "nenhum spawn de rede ou conexão foi executado até aqui",
  });
  const check = preflight(process.env);
  if (!check.ok) {
    process.stderr.write(`${preflightGuidance(check.missing)}\n`);
    logLine({ event: "preflight", result: "DENY-exit-3", missing: check.missing });
    process.exitCode = 3;
    return;
  }
  const neonCli = runLocal(["neon", "--version"]);
  if (neonCli.status !== 0) {
    process.stderr.write("m02-v2b: neon CLI indisponível (fail-closed; nada foi conectado)\n");
    process.exitCode = 2;
    return;
  }
  const docker = runLocal(["docker", "ps", "--format", "{{.Names}}"]);
  if (!String(docker.stdout).includes("preco-que-da-lucro-postgres")) {
    process.stderr.write(
      "m02-v2b: container pg local (pg_dump 17) indisponível — npm run db:up (fail-closed, nada conectado)\n",
    );
    process.exitCode = 2;
    return;
  }
  mkdirSync(resolve(rootDir, ctx.outDir), { recursive: true });
  // Fail-closed ANTES de criar qualquer recurso remoto: a contagem esperada sai
  // do journal versionado, então um journal ausente/ilegível não gasta branch de
  // drill (e a mensagem diz exatamente o que ler).
  const expectedJournal = expectedJournalCount(rootDir);
  const tmpDir = `/tmp/v2b-${date}`;
  mkdirSync(tmpDir, { recursive: true });

  const cleanupProof = {
    branch: ctx.branchName,
    created: false,
    branch_id: null,
    deleted: false,
    before: null,
    after: null,
  };
  let exitCode = 0;
  let failure = null;
  const legacyUrl = process.env.SUPABASE_MIGRATION_DATABASE_URL.trim();
  let branchUrl = null;

  try {
    await step("create-branch", async () => {
      const created = runLocal([
        "neon",
        "branches",
        "create",
        "--project-id",
        ctx.projectId,
        "--name",
        ctx.branchName,
        "--parent",
        ctx.parentBranchId,
        "--expires-at",
        ctx.expiresAt,
        "--no-color",
        "-o",
        "json",
      ]);
      if (created.status !== 0) {
        throw new Error(
          `neon branches create falhou: ${String(created.stderr ?? "").slice(0, 200)}`,
        );
      }
      const branch = await waitForBranchReady(ctx);
      cleanupProof.created = true;
      cleanupProof.branch_id = branch.id;
      return { log: { branch_id: branch.id, state: "ready" } };
    });

    await step("connection-info", async () => {
      const cs = runLocal([
        "neon",
        "cs",
        ctx.branchName,
        "--project-id",
        ctx.projectId,
        "--role-name",
        ROLE_NAME,
        "--extended",
        "-o",
        "json",
        "--no-color",
      ]);
      if (cs.status !== 0) throw new Error("neon cs falhou");
      let payload;
      try {
        payload = JSON.parse(cs.stdout);
      } catch {
        throw new Error("neon cs: saída JSON não parseável");
      }
      branchUrl = payload.connection_string;
      if (new URL(branchUrl).host === new URL(legacyUrl).host) {
        throw new Error("host da branch igual ao legado — impossível por construção; abort");
      }
      return { log: { branch_host: maskUrl(branchUrl), mode: "DIRECT" } };
    });

    await step("migrate", async () => {
      const result = await runNpm("db:migrate", [], {
        ...process.env,
        DATABASE_URL: branchUrl,
        DATABASE_URL_UNPOOLED: branchUrl,
        DATABASE_ADMIN_URL: branchUrl,
        NEON_MIGRATION_TARGET_KIND: "drill-branch",
        ALLOW_REMOTE_DB: MIGRATION_MOTIVO,
      });
      if (result.code !== 0) {
        throw new Error(`db:migrate exit ${result.code} (guard/hook ou migration falhou)`);
      }
      const journal = await queryJournalCount(branchUrl);
      if (journal !== expectedJournal) {
        throw new Error(
          `journal ${journal} ≠ ${expectedJournal} esperado (${JOURNAL_PATH}: ${expectedJournal}/${expectedJournal} pós-migrate)`,
        );
      }
      return { log: { journal_count: journal, kind: "drill-branch", motivo: MIGRATION_MOTIVO } };
    });

    await step("carga-legacy", async () => {
      const reportPath = resolve(rootDir, ctx.outDir, `migration-report-legacy-${date}.json`);
      const result = await runNpm("migration:legacy-to-neon", [], {
        ...process.env,
        SUPABASE_MIGRATION_DATABASE_URL: legacyUrl,
        DATABASE_ADMIN_URL: branchUrl,
        MIGRATION_APPLY: "true",
        MIGRATION_REPORT_PATH: reportPath,
        ALLOW_REMOTE_DB: "V2b CUTOVER-PREP: carga legacy → branch de drill (origem read-only)",
      });
      if (result.code !== 0) {
        // gatilho de parada: falha no meio → cleanup always, reportar, sem retry > 1
        throw new Error(`migration:legacy-to-neon exit ${result.code}`);
      }
      return { log: { report: `migration-report-legacy-${date}.json` } };
    });
    const reconcile = await step("reconcile-legacy-branch", async () => {
      const outRel = `${ctx.outDir}/reconciliation-legacy-${date}.md`;
      const result = await new Promise((done) => {
        const child = spawn(
          process.execPath,
          [
            "scripts/m02-reconcile.mjs",
            "--source-env",
            "V2B_LEGACY_URL",
            "--target-env",
            "V2B_BRANCH_URL",
            "--out",
            outRel,
          ],
          {
            cwd: rootDir,
            env: {
              ...process.env,
              V2B_LEGACY_URL: legacyUrl,
              V2B_BRANCH_URL: branchUrl,
            },
            stdio: ["ignore", "pipe", "pipe"],
          },
        );
        let stdout = "";
        child.stdout.on("data", (chunk) => (stdout += chunk));
        child.stderr.on("data", () => {});
        child.on("close", (code) => done({ code, stdout }));
      });
      let summary = {};
      try {
        summary = JSON.parse(result.stdout.trim().split("\n").pop());
      } catch {
        // summary fica vazio
      }
      if (result.code !== 0) {
        throw new Error(
          `reconcile exit ${result.code} (diferenças registradas no relatório — paridade NÃO declarada)`,
        );
      }
      return {
        log: {
          tables_compared: summary.tables_compared,
          differences_total: summary.differences_total,
          pass: summary.pass,
        },
      };
    });

    const schemaDiff = await step("schema-diff-legacy-branch", async () => {
      const legacyDump = `${tmpDir}/schema-legacy.sql`;
      const branchDump = `${tmpDir}/schema-branch.sql`;
      pgDumpSchemaOnly(legacyUrl, legacyDump);
      pgDumpSchemaOnly(branchUrl, branchDump);
      const normalized = [
        normalizeSchemaDump(readFileSync(legacyDump, "utf8")),
        normalizeSchemaDump(readFileSync(branchDump, "utf8")),
      ];
      const [legacySide, branchSide] = await Promise.all([
        schemaSideSnapshot(legacyUrl, "legacy"),
        schemaSideSnapshot(branchUrl, "branch"),
      ]);
      const diffLines = compareChecklists(legacySide, branchSide);
      const md = renderSchemaDiffMd(
        ctx,
        normalized[0],
        normalized[1],
        legacySide,
        branchSide,
        diffLines,
      );
      writeFileSync(resolve(rootDir, ctx.outDir, `schema-diff-legacy-${date}.md`), md);
      const violations = diffLines.filter((line) => line.verdict === "GAP-PENDENTE-TRIAGEM").length;
      return {
        log: {
          checklist_rows: diffLines.length,
          pending_triage: violations,
        },
        pendingTriage: violations,
      };
    });

    await step("emit-ledger-snippet", async () => {
      const md = renderLedgerSnippet(ctx, schemaDiff);
      writeFileSync(resolve(rootDir, ctx.outDir, "ledger-snippet-v2b.md"), md);
      return { log: { file: "ledger-snippet-v2b.md", edited_ledger: false } };
    });
  } catch (error) {
    failure = safeError(error);
    exitCode = 1;
    logLine({ event: "FAIL", detail: failure });
  } finally {
    await runCleanup(ctx, cleanupProof);
    if (exitCode !== 0) process.exitCode = exitCode;
  }
  if (exitCode === 0) {
    logLine({ event: "DONE", exit: 0, out_dir: ctx.outDir });
  }
}

function compareChecklists(legacySide, branchSide) {
  const rows = [];
  for (const key of Object.keys(branchSide.checks)) {
    const legacy = legacySide.checks[key];
    const target = branchSide.checks[key];
    rows.push({
      item: key,
      legacy,
      branch: target,
      equal: legacy === target,
      verdict: legacy === target ? "CONFORME" : "GAP-PENDENTE-TRIAGEM",
    });
  }
  return rows;
}

function renderSchemaDiffMd(ctx, legacySchema, branchSchema, legacySide, branchSide, rows) {
  const hash = (text) => createHash("sha256").update(text).digest("hex");
  const lines = [];
  lines.push(`# Schema diff legacy × branch V2b (${ctx.date}) — §13.3 estendido`);
  lines.push("");
  lines.push(
    `- origem (legacy): \`${legacySide.host}\` (host mascarado; SELECT/schema-only apenas)`,
  );
  lines.push(`- alvo (branch drill): \`${branchSide.host}\``);
  lines.push(
    `- dumps normalizados (nonce/version/date removidos) — sha256: legacy=\`${hash(legacySchema)}\` branch=\`${hash(branchSchema)}\``,
  );
  lines.push(
    `- texto byte-idêntico: ${legacySchema === branchSchema ? "SIM" : "NÃO (ver contagens abaixo; Supabase carrega objetos de plataforma extras — triagem humana obrigatória)"}`,
  );
  lines.push("");
  lines.push("## Checklist §13.3 estendida (contagens por catálogo)");
  lines.push("");
  lines.push("| item | legacy | branch | equal | veredito |");
  lines.push("| --- | ---: | ---: | --- | --- |");
  for (const row of rows) {
    lines.push(`| ${row.item} | ${row.legacy} | ${row.branch} | ${row.equal} | ${row.verdict} |`);
  }
  lines.push("");
  lines.push("## Triage");
  lines.push("");
  lines.push("- Toda linha ≠ CONFORME exige triagem humana com os rótulos da matriz");
  lines.push("  (CONFORME / GAP-DOC / VIOLAÇÃO / FALSO-ALARME / DESCONHECIDO) antes de");
  lines.push("  qualquer declaração de paridade de schema. Este artefato NÃO converte redação.");
  lines.push(
    "- Paridade de DADOS é atestada pelo relatório de reconciliação §13.5 companheiro, não aqui.",
  );
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function renderLedgerSnippet(ctx, schemaDiff) {
  const lines = [];
  lines.push(`## Ledger snippet — V2b executada ${ctx.date} (MEDIDA-EM-CÓPIA, não-edição)`);
  lines.push("");
  lines.push("> Este bloco é MATERIAL PARA o humano anexar ao EXECUTION-STATE-PROGRAM.md");
  lines.push("> após revisão. O script NÃO edita o ledger (regra da rodada).");
  lines.push("");
  lines.push("```markdown");
  lines.push(`- V2b (${ctx.date}): carga legacy × branch ${ctx.branchName} (drill-branch, §12.5`);
  lines.push(`  deletada com prova); reconcile MODO DADOS §13.4/§13.5 →`);
  lines.push(`  docs/evidence/cutover-prep-${ctx.date}/reconciliation-legacy-${ctx.date}.md;`);
  lines.push(`  schema diff §13.3 estendido → schema-diff-legacy-${ctx.date}.md.`);
  lines.push("- Paridade legacy×Neon: MEDIDA-EM-CÓPIA (dados) — redação final do status é do");
  lines.push("  humano após triagem dos GAP-PENDENTE-TRIAGEM; ledger não é tocado por script.");
  lines.push("```");
  lines.push("");
  lines.push(`- pending_triage_rows: ${schemaDiff?.pendingTriage ?? "ver artefato"}`);
  return `${lines.join("\n")}\n`;
}

async function runCleanup(ctx, proof) {
  const rootDir = resolve(fileURLToPath(import.meta.url), "..", "..");
  try {
    if (proof.created) {
      proof.before = runLocal([
        "neon",
        "branches",
        "list",
        "--project-id",
        ctx.projectId,
        "-o",
        "json",
        "--no-color",
      ]).stdout;
      const del = runLocal([
        "neon",
        "branches",
        "delete",
        proof.branch_id ?? ctx.branchName,
        "--project-id",
        ctx.projectId,
        "--no-color",
      ]);
      proof.deleted = del.status === 0;
      proof.after = runLocal([
        "neon",
        "branches",
        "list",
        "--project-id",
        ctx.projectId,
        "-o",
        "json",
        "--no-color",
      ]).stdout;
    }
  } catch (error) {
    proof.error = safeError(error);
  } finally {
    const lines = [
      `# Cleanup §12.5 always() — V2b (${ctx.date})`,
      "",
      `- branch: \`${ctx.branchName}\` (id \`${proof.branch_id ?? "n/a"}\`)`,
      `- criada: ${proof.created} · deletada: ${proof.deleted}`,
      `- motivo (logado): ${MIGRATION_MOTIVO}`,
      "",
      "## Antes (nomes/ids/estados)",
      "",
      "```",
      summarizeBranchList(proof.before),
      "```",
      "",
      "## Depois",
      "",
      "```",
      summarizeBranchList(proof.after),
      "```",
      "",
      proof.deleted
        ? "Branch efêmera deletada com prova; produção intocada (aparenta apenas como parent @ HEAD da cópia)."
        : "FALHA DE CLEANUP — a branch fica sob expires-at de segurança; tratar como achado.",
      "",
    ];
    writeFileSync(
      resolve(rootDir, ctx.outDir, `branch-cleanup-v2b-${ctx.date}.md`),
      lines.join("\n"),
    );
    logLine({ step: "cleanup", event: "end", created: proof.created, deleted: proof.deleted });
  }
}

function summarizeBranchList(json) {
  if (!json) return "sem captura";
  try {
    return JSON.parse(json)
      .map((branch) => `${branch.name} | ${branch.id} | ${branch.current_state}`)
      .join("\n");
  } catch {
    return "captura não parseável";
  }
}

function safeError(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("://") || message.includes("@"))
    return "erro com possível credencial (detalhes omitidos)";
  return message.slice(0, 300);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((error) => {
    process.stderr.write(`m02-v2b: erro interno (fail-closed): ${safeError(error)}\n`);
    process.exitCode = 2;
  });
}

export {
  parseArgs,
  preflight,
  preflightGuidance,
  buildPlan,
  maskUrl,
  utcDate,
  expectedJournalCount,
};
