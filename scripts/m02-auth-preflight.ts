// m02-auth-preflight.ts — §13.6 (preparação do cutover): pré-voo de env do alvo por
// NOME/ESTADO. SOMENTE LEITURA: não escreve arquivo, não abre socket, não muta nada.
//
// Norma de segredos: a saída NUNCA contém valor de variável — nem inteiro, nem truncado,
// nem parcial, nem hash, nem comprimento. Só aparecem nome da variável, presença
// (present/empty/absent), exigência, veredito e detalhe derivados da política de
// `src/server/auth/auth-policy.ts` (fonte única) e, para o par de e-mail, do próprio
// `getEmailAdapter()` (`src/server/email/email-adapter.server.ts`).
//
// Uso:
//   node node_modules/tsx/dist/cli.mjs scripts/m02-auth-preflight.ts [--json]
//   node --env-file=<export-do-painel> node_modules/tsx/dist/cli.mjs scripts/m02-auth-preflight.ts
//   (--target-label <texto> rotula o alvo no relatório; --require-email trata o par de
//    e-mail como bloqueio, e não como bloqueio condicional)
//
// O script classifica o ambiente DESTE processo. Ele não lê o painel do alvo: para medir
// o alvo, o export de nomes/valores do painel entra por `node --env-file=<arquivo>` e
// continua sem ser impresso.
//
// Exit codes: 0 = sem bloqueio · 1 = bloqueio · 2 = uso inválido.

import {
  authEnvPresence,
  describeAuthEnv,
  type AuthEnvEntry,
  type AuthEnvPresence,
} from "../src/server/auth/auth-policy";
import { getEmailAdapter } from "../src/server/email/email-adapter.server";

type Requirement = AuthEnvEntry["requirement"] | "required-for-auth-email";

interface PreflightEntry extends Omit<AuthEnvEntry, "requirement"> {
  requirement: Requirement;
  blocking: boolean;
}

const EMAIL_PAIR = ["RESEND_API_KEY", "AUTH_EMAIL_FROM"] as const;

const USAGE =
  "uso: node node_modules/tsx/dist/cli.mjs scripts/m02-auth-preflight.ts " +
  "[--json] [--require-email] [--target-label <texto>]";

function usageError(message: string): never {
  console.error(`m02-auth-preflight: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

function parseArgs(argv: string[]): { json: boolean; requireEmail: boolean; targetLabel: string } {
  let json = false;
  let requireEmail = false;
  let targetLabel = "processo local (sem rótulo)";
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--json") json = true;
    else if (arg === "--require-email") requireEmail = true;
    else if (arg === "--target-label") {
      const value = argv[index + 1];
      if (!value) usageError("--target-label exige um valor (rótulo, não segredo)");
      targetLabel = value;
      index += 1;
    } else usageError(`argumento desconhecido: ${arg}`);
  }
  return { json, requireEmail, targetLabel };
}

// O veredito vem da política; aqui só se decide o que é bloqueio de janela.
// `invalid` e `incomplete` são bloqueios em qualquer modo: a instância de auth lança na
// construção (`createAuthInstance`) e toda requisição de auth vira 500.
function blockingVerdict(
  requirement: Requirement,
  verdict: AuthEnvEntry["verdict"],
  production: boolean,
): boolean {
  if (verdict === "invalid" || verdict === "incomplete") return true;
  if (requirement === "required") return verdict !== "ok";
  if (requirement === "required-in-production") return production && verdict !== "ok";
  return false;
}

function emailPairEntries(requireEmail: boolean): PreflightEntry[] {
  const presence = Object.fromEntries(
    EMAIL_PAIR.map((name) => [name, authEnvPresence(process.env[name])]),
  ) as Record<(typeof EMAIL_PAIR)[number], AuthEnvPresence>;
  const missing = EMAIL_PAIR.filter((name) => presence[name] !== "present");

  let verdict: AuthEnvEntry["verdict"] = "missing";
  let detail = `faltando: ${missing.join(", ")}`;
  if (missing.length === 0) {
    try {
      // Reuso real do ponto de enforcement do par: nada de checagem paralela.
      getEmailAdapter();
      verdict = "ok";
      detail = "par aceito por getEmailAdapter() (envio real não é testado aqui)";
    } catch (error) {
      verdict = "invalid";
      detail = `getEmailAdapter() rejeitou o par (erro: ${error instanceof Error ? error.name : "desconhecido"})`;
    }
  }

  return EMAIL_PAIR.map((name) => ({
    name,
    presence: presence[name],
    requirement: "required-for-auth-email" as const,
    verdict,
    detail,
    blocking: requireEmail && verdict !== "ok",
  }));
}

function policyEntries(production: boolean, requireEmail: boolean): PreflightEntry[] {
  const entries: PreflightEntry[] = [
    ...describeAuthEnv(process.env).map((entry) => ({
      ...entry,
      blocking: blockingVerdict(entry.requirement, entry.verdict, production),
    })),
    ...emailPairEntries(requireEmail),
  ];
  return entries;
}

function render(targetLabel: string, production: boolean, entries: PreflightEntry[]): string {
  const nameWidth = Math.max(24, ...entries.map((entry) => entry.name.length));
  const requirementWidth = Math.max(
    "EXIGENCIA".length,
    ...entries.map((entry) => entry.requirement.length),
  );
  const verdictWidth = Math.max("VEREDITO".length, ...entries.map((entry) => entry.verdict.length));
  const header =
    "VARIAVEL".padEnd(nameWidth) +
    "  " +
    "PRESENCA".padEnd(9) +
    "  " +
    "EXIGENCIA".padEnd(requirementWidth) +
    "  " +
    "VEREDITO".padEnd(verdictWidth) +
    "  DETALHE";
  const rows = entries.map((entry) =>
    [
      entry.name.padEnd(nameWidth),
      entry.presence.padEnd(9),
      entry.requirement.padEnd(requirementWidth),
      entry.verdict.padEnd(verdictWidth),
      entry.detail,
    ].join("  "),
  );
  const blockers = entries.filter((entry) => entry.blocking);
  return [
    "m02-auth-preflight — §13.6 pré-voo de env por NOME/ESTADO (nenhum valor é impresso)",
    `alvo: ${targetLabel}`,
    `modo: ${production ? "produção (NODE_ENV=production)" : "não-produção"}`,
    "escopo: variáveis adjudicadas por src/server/auth/auth-policy.ts + par de e-mail de auth",
    "fora do escopo: DATABASE_*, AI_*, SUPABASE_*, MIGRATION_* — checklist por NOME de cutover-A4.md §4.4",
    "",
    header,
    ...rows,
    "",
    blockers.length === 0
      ? "BLOQUEIOS: nenhum"
      : `BLOQUEIOS: ${blockers.map((entry) => `${entry.name} (${entry.verdict})`).join(", ")}`,
    `RESULTADO: ${blockers.length === 0 ? "PASS" : "FAIL"} — sem veredito sobre o que não foi medido`,
  ].join("\n");
}

const { json, requireEmail, targetLabel } = parseArgs(process.argv.slice(2));
const production = process.env.NODE_ENV === "production";
const entries = policyEntries(production, requireEmail);
const blockers = entries.filter((entry) => entry.blocking);

if (json) {
  console.log(
    JSON.stringify(
      {
        targetLabel,
        production,
        entries,
        blockers: blockers.map((entry) => entry.name),
        verdict: blockers.length === 0 ? "PASS" : "FAIL",
        note: "Relatório por nome/estado: nenhum valor de variável é lido para a saída.",
      },
      null,
      2,
    ),
  );
} else {
  console.log(render(targetLabel, production, entries));
}

process.exit(blockers.length === 0 ? 0 : 1);
