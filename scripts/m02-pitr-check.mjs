// m02-pitr-check.mjs — §13.7 (rollback/PITR): MEDE a janela de PITR (history
// retention) do projeto Neon e a compara com o mínimo de SDD §16.6 (≥ 7 dias).
// SOMENTE LEITURA: este script NUNCA emite PATCH/PUT — elevar a janela é ação
// humana de H-4 (plano pago), fora deste script.
//
// Contrato:
//   node scripts/m02-pitr-check.mjs [--min-sec <segundos>] [--plan]
//   - --plan: imprime o contrato de endpoints SEM abrir socket (exit 0 sempre,
//     com ou sem credencial).
//   - --min-sec: mínimo exigido em segundos; default 604800 (7 d, SDD §16.6).
//   - Exige NEON_API_KEY + NEON_PROJECT_ID no ambiente. Ausente(s) → SKIP
//     ROTULADO (exit 0) e a saída declara que NENHUMA chamada live foi feita:
//     skip NÃO é evidência de conformidade, a janela ficou NÃO MEDIDA.
//
// Endpoint (forma confirmada só pelo uso já existente no repositório: o base
// /api/v2 e o path /projects/{id} são os de .github/workflows/neon-drill-ops.yml
// e neon-pr-branch.yml; o campo history_retention_seconds é o citado pelo memo
// v2 (neon-pitr-memo-2026-09-12.md) e pelo §12.6 do plano):
//   GET {NEON_API_BASE}/projects/{project_id} → { project: { … } }
//   campo medido: project.history_retention_seconds
//   TO-CONFIRM: envelope exato da resposta sem chave (por isso o leitor aceita
//   {project:{…}} ou o objeto plano) e a forma de erro do PATCH.
//
// Limites que este check NÃO mede (dizer sempre, junto do drill): o PITR
// restaura APENAS branches raiz e SOBRESCREVE a branch restaurada — logo não é
// restore isolado e não substitui o dump externo verificado nem o drill de
// branch isolada (NFR-RES-005). O drill NUNCA toca a produção (projeto/branch
// descartável). Rollback pós-tráfego é snapshot/PITR, nunca down-migration:
// drizzle/rollback/0010_to_0009_down.sql permanece LOCKED.
//
// Norma de segredos: a chave nunca é impressa nem ecoada (mensagens de erro
// passam por redactSecret); a saída não contém chave, URL de conexão nem ids
// de branch, e o id do projeto aparece somente como booleano de presença.
//
// Exit codes: 0 PASS ou SKIP rotulado · 1 FAIL (janela < mínimo) ·
//             2 INCOMPLETE (HTTP ≠ 200, corpo inesperado, rede) — fail-closed.

const DEFAULT_API_BASE = "https://console.neon.tech/api/v2";
const MIN_RETENTION_SECONDS = 604800; // 7 dias — SDD §16.6
const SECONDS_PER_DAY = 86400;
const REQUEST_TIMEOUT_MS = 15_000;
const REQUIREMENT = "SDD §16.6 — PITR mínimo de 7 dias em produção (≥ 604800 s)";

const SCOPE_NOTES = [
  "PITR restaura APENAS branches raiz e SOBRESCREVE a branch restaurada: não é restore isolado e não substitui o dump externo verificado (m02:snapshot + m02:backup-verify, NFR-RES-005).",
  "O drill de PITR NUNCA toca a produção: usa projeto/branch descartável; a produção nunca é alvo de restore.",
  "Rollback pós-tráfego é snapshot/PITR, nunca down-migration: drizzle/rollback/0010_to_0009_down.sql permanece LOCKED.",
];

function usage() {
  return [
    "uso: node scripts/m02-pitr-check.mjs [--min-sec <segundos>] [--plan]",
    "  --plan     imprime o contrato de endpoints sem abrir socket (exit 0 sempre)",
    "  --min-sec  mínimo exigido em segundos (default 604800 = 7 dias, SDD §16.6)",
    "  sem flags: exige NEON_API_KEY + NEON_PROJECT_ID; sem eles, SKIP rotulado (exit 0)",
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = { plan: false, minSeconds: MIN_RETENTION_SECONDS };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--plan") {
      parsed.plan = true;
      continue;
    }
    let raw;
    if (arg.startsWith("--min-sec=")) raw = arg.slice("--min-sec=".length);
    else if (arg === "--min-sec") {
      index += 1;
      raw = argv[index];
    } else return { error: `argumento não reconhecido: ${arg}` };
    if (typeof raw !== "string" || !/^[0-9]+$/.test(raw) || Number(raw) <= 0) {
      return {
        error: `--min-sec inválido: ${raw ?? "<ausente>"} (inteiro > 0, em segundos)`,
      };
    }
    parsed.minSeconds = Number(raw);
  }
  return parsed;
}

/** Pré-conexão: devolve APENAS os nomes ausentes — nunca valores de env. */
function preflight(env) {
  const missing = [];
  if (typeof env.NEON_API_KEY !== "string" || env.NEON_API_KEY.trim() === "") {
    missing.push("NEON_API_KEY");
  }
  if (typeof env.NEON_PROJECT_ID !== "string" || env.NEON_PROJECT_ID.trim() === "") {
    missing.push("NEON_PROJECT_ID");
  }
  return { ok: missing.length === 0, missing };
}

/** Redação defensiva: nenhuma mensagem de erro pode ecoar a chave. */
function redactSecret(text, secret) {
  const raw = typeof text === "string" ? text : String(text);
  if (typeof secret !== "string" || secret === "") return raw;
  return raw.split(secret).join("<redigido>");
}

/**
 * Leitor tolerante do envelope (TO-CONFIRM: forma exata da resposta não
 * verificável sem chave). Aceita { project: { … } } ou o objeto plano.
 * Devolve inteiro ≥ 0 ou null — string de dígitos, ausente ou float = null.
 */
function readRetentionSeconds(payload) {
  if (payload === null || typeof payload !== "object") return null;
  const project = payload.project ?? payload;
  if (project === null || typeof project !== "object") return null;
  const value = project.history_retention_seconds;
  if (!Number.isInteger(value) || value < 0) return null;
  return value;
}

function parseDays(seconds) {
  return Math.round((seconds / SECONDS_PER_DAY) * 1000) / 1000;
}

function evaluateWindow(retentionSeconds, minSeconds = MIN_RETENTION_SECONDS) {
  if (retentionSeconds === null) {
    return {
      status: "DESCONHECIDO",
      detail:
        "history_retention_seconds ausente ou não-inteiro na resposta — janela NÃO medida (exit 2, fail-closed)",
    };
  }
  if (retentionSeconds >= minSeconds) {
    return {
      status: "PASS",
      detail: `janela de ${retentionSeconds} s (${parseDays(retentionSeconds)} d) ≥ mínimo de ${minSeconds} s`,
    };
  }
  return {
    status: "FAIL",
    deficit_seconds: minSeconds - retentionSeconds,
    detail: `janela de ${retentionSeconds} s (${parseDays(retentionSeconds)} d) < mínimo de ${minSeconds} s — BAK-01b ABERTO (H-4)`,
  };
}

function planReport(minSeconds) {
  return {
    check: "m02:pitr-check",
    mode: "plan",
    read_only: true,
    live_call: false,
    requirement: REQUIREMENT,
    min_seconds: minSeconds,
    endpoints: [
      {
        method: "GET",
        path: "{NEON_API_BASE}/projects/{project_id}",
        used_for: "leitura da janela de PITR (campo project.history_retention_seconds)",
        http_status: "esperado 200",
      },
      {
        method: "PATCH",
        path: "{NEON_API_BASE}/projects/{project_id}",
        used_for:
          "elevar a janela pós-H-4 (corpo com history_retention_seconds) — NÃO emitido por este script; passo humano documentado no memo v3",
        parameter_names:
          "TO-CONFIRM (o nome do campo no corpo é o citado pelo §12.6 do plano; forma/limites por plano não confirmados sem chave)",
      },
    ],
    steps: [
      "preflight: NEON_API_KEY + NEON_PROJECT_ID presentes (nomes, nunca valores)",
      "GET do projeto e leitura de history_retention_seconds",
      "comparação com --min-sec (default 604800) → PASS/FAIL/DESCONHECIDO",
    ],
    exit_codes: { 0: "PASS ou SKIP rotulado", 1: "FAIL", 2: "INCOMPLETE (fail-closed)" },
    notes: SCOPE_NOTES,
  };
}

function skipReport(missing, minSeconds = MIN_RETENTION_SECONDS) {
  return {
    check: "m02:pitr-check",
    mode: "run",
    read_only: true,
    live_call: false,
    result: "SKIP",
    skip_reason: `${missing.join(" + ")} ausente(s) no ambiente`,
    missing,
    requirement: REQUIREMENT,
    min_seconds: minSeconds,
    detail:
      "NENHUMA chamada live foi feita: a janela de PITR NÃO foi medida. Skip não é evidência de conformidade (tampouco de violação).",
    notes: SCOPE_NOTES,
  };
}

function incompleteReport({ detail, httpStatus = null, apiBase, projectId }) {
  return {
    check: "m02:pitr-check",
    mode: "run",
    read_only: true,
    live_call: true,
    result: "INCOMPLETE",
    fail_closed: true,
    http_status: httpStatus,
    api_base: apiBase,
    project_ref_present: typeof projectId === "string" && projectId.trim() !== "",
    requirement: REQUIREMENT,
    detail,
    notes: SCOPE_NOTES,
  };
}

/**
 * Checagem injetável (fetch mockado nos testes). Devolve { report, exitCode }.
 * NUNCA emite método diferente de GET.
 */
async function checkPitr({
  fetchImpl,
  apiBase = DEFAULT_API_BASE,
  projectId,
  apiKey,
  minSeconds = MIN_RETENTION_SECONDS,
}) {
  const base = { apiBase, projectId };
  const startedAt = new Date().toISOString();
  let response;
  try {
    response = await fetchImpl(`${apiBase}/projects/${encodeURIComponent(projectId)}`, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const message = redactSecret(error instanceof Error ? error.message : String(error), apiKey);
    return {
      report: {
        ...incompleteReport({
          ...base,
          detail: `falha de rede/timeout na chamada GET: ${message}`,
        }),
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      },
      exitCode: 2,
    };
  }

  if (!response.ok) {
    return {
      report: {
        ...incompleteReport({
          ...base,
          httpStatus: response.status,
          detail: `GET /projects/{project_id} devolveu HTTP ${response.status} — janela NÃO medida`,
        }),
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      },
      exitCode: 2,
    };
  }

  let payload;
  try {
    payload = await response.json();
  } catch (error) {
    const message = redactSecret(error instanceof Error ? error.message : String(error), apiKey);
    return {
      report: {
        ...incompleteReport({ ...base, detail: `corpo do projeto não é JSON: ${message}` }),
        started_at: startedAt,
        finished_at: new Date().toISOString(),
      },
      exitCode: 2,
    };
  }

  const retentionSeconds = readRetentionSeconds(payload);
  const verdict = evaluateWindow(retentionSeconds, minSeconds);
  const exitCode = verdict.status === "PASS" ? 0 : verdict.status === "FAIL" ? 1 : 2;
  return {
    report: {
      check: "m02:pitr-check",
      mode: "run",
      read_only: true,
      live_call: true,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      result: verdict.status,
      source: "GET /projects/{project_id} (Neon API v2)",
      project_ref_present: true,
      requirement: REQUIREMENT,
      min_seconds: minSeconds,
      history_retention_seconds: retentionSeconds,
      history_retention_days: retentionSeconds === null ? null : parseDays(retentionSeconds),
      ...(verdict.deficit_seconds === undefined
        ? {}
        : { deficit_seconds: verdict.deficit_seconds }),
      detail: verdict.detail,
      notes: SCOPE_NOTES,
    },
    exitCode,
  };
}

function emit(payload) {
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

async function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`${parsed.error}\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  if (parsed.plan) {
    emit(planReport(parsed.minSeconds));
    return;
  }
  const check = preflight(process.env);
  if (!check.ok) {
    emit(skipReport(check.missing, parsed.minSeconds));
    return; // exit 0: skip rotulado, nunca fail silencioso nem rede improvisada
  }
  const { report, exitCode } = await checkPitr({
    fetchImpl: globalThis.fetch,
    apiBase: process.env.NEON_API_BASE || DEFAULT_API_BASE,
    projectId: process.env.NEON_PROJECT_ID,
    apiKey: process.env.NEON_API_KEY,
    minSeconds: parsed.minSeconds,
  });
  emit(report);
  process.exitCode = exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export {
  DEFAULT_API_BASE,
  MIN_RETENTION_SECONDS,
  REQUIREMENT,
  SCOPE_NOTES,
  checkPitr,
  evaluateWindow,
  parseArgs,
  planReport,
  preflight,
  readRetentionSeconds,
  redactSecret,
  skipReport,
};
