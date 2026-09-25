// m02-role-membership.mjs — fecha o GAP-TOOLING (cutover-2026-09-07
// evidence.json: "db:migrate não invoca ensureRuntimeRoleMembership").
// Operador idempotente da membership admin→app_runtime (grant com SET OPTION),
// com a MESMA fonte de verdade de scripts/db/migrate.ts (nenhum SQL duplicado).
//
// Contrato:
//   npm run m02:role-membership -- --target-env <NOME_DA_ENV> --kind <drill-branch|cutover-window> [--dry-run] [--out <md>]
//   - A URL vem SEMPRE da env indicada pelo NOME (nunca valor em argv, nunca impressa).
//   - kind=drill-branch: alvo DEVE ser host ≠ produção (Emenda #2) — escrita da
//     membership sancionada em branch de drill efêmera.
//   - kind=cutover-window: alvo de produção SOMENTE dentro da janela de freeze
//     válida da Emenda #3 (NEON_MIGRATION_FREEZE_START/END vigentes +
//     ALLOW_REMOTE_DB=<motivo>); fora da janela → exit 3 pré-conexão, fail-closed.
//   - --dry-run: apenas leitura — reporta estado atual da membership e o que o
//     ensure faria; nenhuma escrita é emitida.
//   - Idempotência: a 2ª execução é no-op (diff de estado vazio) por construção
//     do bloco DO em scripts/db/migrate.ts:108.
// Exit codes: 0 ok · 3 fora de janela/alvo proibido (pré-conexão) · 2 fail-closed.

import { existsSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { Client } from "pg";
import { ensureRuntimeRoleMembership } from "./db/migrate.ts";

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const PRODUCTION_ENDPOINT_PREFIX = "ep-long-violet-aye9g0bn";
const NORMA = "docs/specs/M-02/emenda-2026-09-07-env-guard.md";
const REPOSITORY_ROOT = realpathSync(resolve(import.meta.dirname, ".."));
const TEMP_ROOT = realpathSync(tmpdir());

function usage() {
  return [
    "uso: npm run m02:role-membership -- --target-env <ENV> --kind <drill-branch|cutover-window> [--dry-run] [--out <md>]",
    "A URL de conexão é lida da variável de ambiente indicada (valor nunca impresso).",
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = { targetEnv: undefined, kind: undefined, dryRun: false, out: undefined };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = (name) => {
      if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
      if (arg === `--${name}`) {
        index += 1;
        return argv[index];
      }
      return undefined;
    };
    if (arg === "--dry-run") {
      parsed.dryRun = true;
      continue;
    }
    const target = take("target-env");
    if (target !== undefined) {
      parsed.targetEnv = target;
      continue;
    }
    const kind = take("kind");
    if (kind !== undefined) {
      parsed.kind = kind;
      continue;
    }
    const out = take("out");
    if (out !== undefined) {
      parsed.out = out;
      continue;
    }
    return { error: `argumento não reconhecido: ${arg}` };
  }
  if (!parsed.targetEnv) return { error: "--target-env é obrigatório" };
  if (!["drill-branch", "cutover-window"].includes(parsed.kind)) {
    return { error: "--kind deve ser drill-branch ou cutover-window" };
  }
  return parsed;
}

function maskHost(url) {
  try {
    return new URL(url).hostname;
  } catch {
    return "<malformada>";
  }
}

/** Mesma semântica da Emenda #3 (scripts/env-guard.mjs validateFreezeWindow). */
function validateFreezeWindow(env, now = new Date()) {
  const start =
    typeof env.NEON_MIGRATION_FREEZE_START === "string"
      ? new Date(env.NEON_MIGRATION_FREEZE_START)
      : null;
  const end =
    typeof env.NEON_MIGRATION_FREEZE_END === "string"
      ? new Date(env.NEON_MIGRATION_FREEZE_END)
      : null;
  if (
    !start ||
    !end ||
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    start.getTime() >= end.getTime()
  ) {
    return { ok: false, reason: "janela de freeze ausente/malformada (ISO 8601 exigido)" };
  }
  const time = now.getTime();
  if (time < start.getTime()) return { ok: false, reason: "freeze ainda não começou" };
  if (time > end.getTime()) return { ok: false, reason: "freeze expirado" };
  return { ok: true, reason: "dentro da janela" };
}

async function membershipState(client) {
  const result = await client.query(`
    select exists (
      select 1
      from pg_auth_members m
      join pg_roles granted on granted.oid = m.roleid
      join pg_roles member on member.oid = m.member
      where granted.rolname = 'app_runtime' and member.rolname = current_user and m.set_option
    ) as has_set_membership,
    exists (select 1 from pg_roles where rolname = 'app_runtime') as app_runtime_exists,
    current_user as member_role,
    (select rolbypassrls from pg_roles where rolname = 'app_runtime') as app_runtime_bypassrls,
    (select rolsuper from pg_roles where rolname = 'app_runtime') as app_runtime_superuser
  `);
  return result.rows[0];
}

function renderMarkdown(payload) {
  const lines = [
    `# Role membership — m02-role-membership (${payload.executed_at})`,
    "",
    `- kind: \`${payload.kind}\` · dry-run: ${payload.dry_run}`,
    `- alvo: host mascarado \`${payload.host}\` · local: ${payload.local}`,
    `- motivo (logado): ${payload.motivo ?? "(nenhum — dry-run/drill)"}`,
    payload.window
      ? `- janela de freeze: ${payload.window.ok ? "VIGENTE" : "inválida"} — ${payload.window.reason}`
      : "",
    `- membership antes: has_set_membership=${payload.before.has_set_membership} (app_runtime existe=${payload.before.app_runtime_exists}, bypassrls=${payload.before.app_runtime_bypassrls}, superuser=${payload.before.app_runtime_superuser})`,
    payload.dry_run
      ? `- ação: nenhuma (dry-run); ensure criaria a membership se ${payload.before.has_set_membership ? "NÂO (já existe → no-op)" : "SIM"}`
      : `- ação: ensureRuntimeRoleMembership executado; depois: has_set_membership=${payload.after.has_set_membership}`,
    payload.dry_run
      ? ""
      : `- idempotente: ${payload.before.has_set_membership === payload.after.has_set_membership ? "estado inalterado (no-op) ou criado" : "criada nesta execução"}`,
    "",
  ].filter((line) => line !== "");
  return `${lines.join("\n")}\n`;
}

function isWithin(base, candidate) {
  const descendant = relative(base, candidate);
  return descendant === "" || (!descendant.startsWith(`..${sep}`) && !isAbsolute(descendant));
}

function existingParent(candidate) {
  let lexical = dirname(candidate);
  while (!existsSync(lexical)) {
    const parent = dirname(lexical);
    if (parent === lexical) throw new Error("diretório pai da saída não pode ser resolvido");
    lexical = parent;
  }
  return { lexical, real: realpathSync(lexical) };
}

function resolveOutputFile(raw) {
  const candidate = resolve(raw);
  const allowedRoot = [REPOSITORY_ROOT, TEMP_ROOT].find((root) => isWithin(root, candidate));
  if (!allowedRoot) throw new Error("arquivo de saída fora das raízes permitidas; fail-closed");
  const parent = existingParent(candidate);
  if (!isWithin(allowedRoot, parent.real)) {
    throw new Error("pai da saída usa symlink fora da raiz permitida; fail-closed");
  }
  const safeCandidate = resolve(parent.real, relative(parent.lexical, candidate));
  if (!isWithin(allowedRoot, safeCandidate)) {
    throw new Error("arquivo de saída fora da raiz permitida; fail-closed");
  }
  if (existsSync(safeCandidate)) {
    const real = realpathSync(safeCandidate);
    if (real !== safeCandidate || !statSync(real).isFile()) {
      throw new Error("arquivo de saída existente não é um arquivo regular seguro; fail-closed");
    }
  }
  return safeCandidate;
}

function companionJsonPath(outPath) {
  return outPath.endsWith(".md") ? `${outPath.slice(0, -3)}.json` : `${outPath}.json`;
}

function preflightTarget(parsed, env) {
  const rawUrl = env[parsed.targetEnv];
  if (typeof rawUrl !== "string" || rawUrl.trim() === "") {
    return {
      ok: false,
      code: 2,
      message: `m02-role-membership: erro de ambiente (fail-closed): env ${parsed.targetEnv} ausente (valores nunca impressos)\n`,
    };
  }

  const url = rawUrl.trim();
  let host;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return {
      ok: false,
      code: 2,
      message: "m02-role-membership: URL malformada (fail-closed; valor omitido)\n",
    };
  }

  const isLocal = LOCAL_HOSTNAMES.has(host);
  const isProduction = host.includes(PRODUCTION_ENDPOINT_PREFIX);
  if (parsed.kind === "drill-branch" && isProduction) {
    return {
      ok: false,
      code: 3,
      message: `${JSON.stringify({
        script: "m02-role-membership",
        result: "DENY-pre-conexao",
        reason: "drill-branch nunca pode mirar produção (Emenda #2)",
      })}\n`,
    };
  }

  let window = null;
  let motivo;
  if (parsed.kind === "cutover-window") {
    window = validateFreezeWindow(env);
    motivo = typeof env.ALLOW_REMOTE_DB === "string" ? env.ALLOW_REMOTE_DB.trim() : "";
    if (!isLocal && !window.ok) {
      return {
        ok: false,
        code: 3,
        message: `${JSON.stringify({
          script: "m02-role-membership",
          result: "DENY-pre-conexao",
          reason: `cutover-window recusado: ${window.reason} (Emenda #3; dry-run remoto também exige janela vigente)`,
        })}\n`,
      };
    }
    if (!isLocal && motivo === "") {
      return {
        ok: false,
        code: 3,
        message: `${JSON.stringify({
          script: "m02-role-membership",
          result: "DENY-pre-conexao",
          reason: "cutover-window exige ALLOW_REMOTE_DB=<motivo> (Emenda #3)",
        })}\n`,
      };
    }
  }

  return { ok: true, url, host, isLocal, window, motivo };
}

function writeRoleMembershipArtifacts(parsed, payload) {
  if (!parsed.out) return;
  const outPath = resolveOutputFile(parsed.out);
  const jsonPath = resolveOutputFile(companionJsonPath(outPath));
  writeFileSync(outPath, renderMarkdown(payload), "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
}

function safeErrorMessage(error) {
  const message = String(error instanceof Error ? error.message : error);
  return message.includes("://")
    ? "erro de conexão/banco (detalhes omitidos)"
    : message.slice(0, 200);
}

async function rollbackQuietly(client) {
  try {
    await client.query("rollback");
  } catch {
    // conexão pode ter caído; nada a fazer
  }
}

async function runMembershipTransaction(client, parsed, payload) {
  await client.query("start transaction");
  payload.before = await membershipState(client);
  if (!payload.before.app_runtime_exists) {
    throw new Error("role app_runtime não existe no catálogo do alvo — migrations não aplicadas?");
  }
  if (parsed.dryRun) {
    await client.query("rollback");
    payload.action = "dry-run: nenhuma escrita";
    return;
  }
  await ensureRuntimeRoleMembership(client);
  payload.after = await membershipState(client);
  payload.idempotent_noop = payload.before.has_set_membership === payload.after.has_set_membership;
  await client.query("commit");
}

async function executeMembership(parsed, target) {
  const { url, host, isLocal, window, motivo } = target;
  const client = new Client({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: true },
    connectionTimeoutMillis: 15000,
  });
  const payload = {
    script: "m02-role-membership",
    executed_at: new Date().toISOString(),
    kind: parsed.kind,
    dry_run: parsed.dryRun,
    host,
    local: isLocal,
    motivo: motivo || null,
    window,
  };
  try {
    await client.connect();
    await runMembershipTransaction(client, parsed, payload);
    writeRoleMembershipArtifacts(parsed, payload);
    process.stdout.write(`${JSON.stringify({ ...payload, url: undefined })}\n`);
    process.exitCode = 0;
  } catch (error) {
    await rollbackQuietly(client);
    process.stderr.write(`m02-role-membership: fail-closed: ${safeErrorMessage(error)}\n`);
    process.exitCode = 2;
  } finally {
    await client.end().catch(() => {});
  }
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`m02-role-membership: ${parsed.error}\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  const target = preflightTarget(parsed, process.env);
  if (!target.ok) {
    process.stderr.write(target.message);
    process.exitCode = target.code;
    return;
  }
  await executeMembership(parsed, target);
}

if (import.meta.url === `file://${process.argv[1]}`) {
  await main();
}

export { parseArgs, validateFreezeWindow, membershipState };
