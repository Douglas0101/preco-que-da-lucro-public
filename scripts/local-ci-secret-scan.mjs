#!/usr/bin/env node
/**
 * Classificador do `range-secret-scan` do `local-ci`.
 *
 * Le registros `<rev>:<path>:<linha>:<conteudo>` (saida de `git grep -nIE`) e decide, por linha:
 *
 *   1. **HARD** — casou um padrao que NUNCA pode ser suprimido (`HARD_PATTERNS`). Sempre hit.
 *   2. **permitido** — casou o padrao LITERAL de uma entrada da allowlist declarada E o arquivo
 *      esta no escopo daquela entrada. Suprimido, contado por id, sem nunca registrar conteudo.
 *   3. **hit** — o resto. Reportado como `arquivo:linha`.
 *
 * A ordem importa e e a defesa contra o fail-open: um padrao duro e avaliado **antes** da allowlist,
 * entao uma linha que contenha ao mesmo tempo a credencial loopback permitida e um `ghp_...` real
 * continua sendo hit. Allowlist que engole segredo real e pior do que ruido.
 *
 * Saida (nunca conteudo, apenas localizacao e contagem):
 *   stdout — uma linha `arquivo:linha` por hit nao permitido
 *   stderr — resumo `total=<n> permitidos=<n> hits=<n> ids=<AL-xx:n,...>`
 *
 * Exit: 0 = classificou | 2 = precondicao (allowlist ausente/ilegivel/invalida, entrada sem campo
 * obrigatorio). Precondicao nunca vira "nada encontrado".
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/** Padroes que a allowlist NAO pode suprimir. Avaliados antes dela. */
const HARD_PATTERNS = [
  { id: "private-key", re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
  { id: "github-pat", re: /\b(?:ghp_|gho_|ghu_|ghs_|ghr_|github_pat_)[A-Za-z0-9_]{20,}/ },
  { id: "openai-key", re: /\bsk-proj-[A-Za-z0-9_-]{20,}/ },
  { id: "slack-token", re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { id: "aws-akid", re: /\bAKIA[0-9A-Z]{16}\b/ },
  { id: "jwt-like", re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/ },
];

const REQUIRED_FIELDS = ["id", "pattern", "scope", "reason", "decidedAt", "decidedBy"];

function fail(message) {
  console.error(`precondicao: ${message}`);
  process.exit(2);
}

const allowlistPath =
  process.env.LOCAL_CI_SECRET_ALLOWLIST ?? "scripts/local-ci-secret-allowlist.json";

let allowlist;
try {
  allowlist = JSON.parse(readFileSync(resolve(allowlistPath), "utf8"));
} catch (error) {
  fail(`allowlist ilegivel em ${allowlistPath} (${error.message})`);
}
if (!Array.isArray(allowlist?.entries)) fail(`allowlist sem array "entries" em ${allowlistPath}`);

// Fail-closed na estrutura: entrada sem campo obrigatorio, padrao vazio ou id duplicado reprovam.
const seenIds = new Set();
for (const [index, entry] of allowlist.entries.entries()) {
  for (const field of REQUIRED_FIELDS) {
    if (typeof entry?.[field] !== "string" || entry[field].trim() === "")
      fail(`entrada ${index} sem campo obrigatorio "${field}"`);
  }
  if (seenIds.has(entry.id)) fail(`id de allowlist duplicado: ${entry.id}`);
  seenIds.add(entry.id);
}

/** Escopo: caminho exato, ou prefixo de diretorio quando termina em "/". */
function inScope(path, scope) {
  return scope.endsWith("/") ? path.startsWith(scope) : path === scope;
}

/**
 * Arquivo que DECLARA os padroes permitidos: por construcao ele contem os literais, entao passa pelo
 * classificador sem consultar a allowlist. Isentar por CODIGO — e nao por uma entrada que permitiria a
 * si mesma — evita allowlist circular.
 *
 * NAO e ponto cego: `HARD_PATTERNS` e avaliado antes, entao um token real nesse arquivo continua
 * sendo hit (N11/N12 em `src/test/local-ci-secret-scan.test.ts`).
 */
const SELF_DECLARATION_PATHS = new Set(["scripts/local-ci-secret-allowlist.json"]);

const input = readFileSync(0, "utf8");
const hits = [];
const allowedById = new Map();
let total = 0;
let selfDeclared = 0;

for (const raw of input.split("\n")) {
  if (raw.trim() === "") continue;
  // `<rev>:<path>:<linha>:<conteudo>` — o conteudo pode conter ":", entao o split e limitado.
  const match = /^(?<rev>[^:]*):(?<path>[^:]*):(?<line>\d+):(?<content>.*)$/.exec(raw);
  if (!match) fail(`linha de entrada fora do formato esperado (${raw.slice(0, 40)}...)`);
  const { path, line, content } = match.groups;
  total += 1;

  const hard = HARD_PATTERNS.find((pattern) => pattern.re.test(content));
  if (hard) {
    hits.push(`${path}:${line}`);
    continue;
  }

  // Autodeclaracao: isento da supressao por allowlist (o arquivo E a allowlist). Passou pelos padroes
  // duros acima, entao um token real aqui continua sendo hit — nao e ponto cego.
  if (SELF_DECLARATION_PATHS.has(path)) {
    selfDeclared += 1;
    continue;
  }

  const allowed = allowlist.entries.find(
    (entry) => inScope(path, entry.scope) && content.includes(entry.pattern),
  );
  if (allowed) {
    allowedById.set(allowed.id, (allowedById.get(allowed.id) ?? 0) + 1);
    continue;
  }

  hits.push(`${path}:${line}`);
}

for (const hit of [...new Set(hits)].sort()) console.log(hit);
const ids = [...allowedById.entries()]
  .sort()
  .map(([id, n]) => `${id}:${n}`)
  .join(",");
console.error(
  `total=${total} permitidos=${total - hits.length - selfDeclared} autodeclarados=${selfDeclared} hits=${new Set(hits).size} ids=${ids || "nenhum"}`,
);
