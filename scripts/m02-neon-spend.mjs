// m02-neon-spend.mjs — §12.6 (guardrails de gasto): inventário LOCAL read-only
// do que é observável hoje, sem plano pago e sem chave com escopo de
// organização. SOMENTE GET: /projects/{id} (history_retention_seconds) e
// /projects/{id}/branches. NÃO configura `spending_limit` (exige plano pago —
// H-4), NÃO consulta consumption v2 (plano pago — H-4) e NÃO emite PATCH/PUT.
//
// Limitação honesta — não vender como guardrail forte: o canal de alerta da
// Neon é SOMENTE e-mail e NÃO suspende compute; um pico de custo consome antes
// de qualquer reação humana. O que faltaria (`spending_limit` e métricas de
// consumption v2) depende de H-4 (plano pago) + chave com escopo de
// organização — hoje inexistente neste ambiente. Guardrail real hoje é o dump
// externo verificado + snapshot/PITR, não alerta de gasto.
//
// Norma de saída (plano §12.6): SOMENTE hostnames. Nenhuma URL de conexão,
// chave, token ou id (projeto/branch/organização) é impressa; o payload bruto
// NUNCA é ecoado — só projeções de campos e a lista de hostnames extraída dele.
// A projeção de branch usa apenas campos cujo nome já aparece no repositório
// (name/primary/default/created_at, ver .github/workflows/neon-drill-ops.yml);
// os campos de consumo por branch são lidos SE presentes e marcados
// TO-CONFIRM — a forma exata da resposta não é verificável sem chave.
//
// Contrato:
//   node scripts/m02-neon-spend.mjs [--plan]
//   - --plan: imprime o contrato de endpoints SEM abrir socket (exit 0 sempre).
//   - Exige NEON_API_KEY + NEON_PROJECT_ID. Ausente(s) → SKIP ROTULADO
//     (exit 0) com a saída declarando que NENHUMA chamada live foi feita.
//
// Exit codes: 0 inventário OK ou SKIP rotulado ·
//             2 INCOMPLETE (HTTP ≠ 200, corpo inesperado, rede) — fail-closed.

const DEFAULT_API_BASE = "https://console.neon.tech/api/v2";
const REQUEST_TIMEOUT_MS = 15_000;

// Campos de consumo por branch: lidos SE presentes. TO-CONFIRM — a presença
// destes nomes na resposta de GET .../branches não é confirmável sem chave.
const BRANCH_USAGE_FIELDS = [
  "compute_time_seconds",
  "active_time_seconds",
  "written_data_bytes",
  "data_transfer_bytes",
];

const GUARDRAIL_LIMITS = {
  spending_limit:
    "NÃO configurável neste estado: exige plano pago (H-4) + chave com escopo de organização; este script não emite PATCH/PUT.",
  consumption_v2:
    "NÃO disponível hoje (plano pago, H-4): nenhuma métrica de consumo por projeto/branch é lida por este script.",
  alert_channel:
    "SOMENTE e-mail e NÃO suspende compute — não é guardrail forte (não contém pico de custo); não descrever como teto de gasto.",
  local_inventory:
    "Este relatório: janela de histórico + inventário de branches (contagens e campos confirmados). NÃO mede consumo e NÃO substitui o teto de gasto.",
};

const SCOPE_NOTES = [
  "Somente GET: nenhum PATCH/PUT é emitido por este script (spending_limit é passo humano pós-H-4).",
  "Saída somente com hostnames: sem URL de conexão, chave, token ou id de projeto/branch/organização.",
  "Rollback pós-tráfego é snapshot/PITR, nunca down-migration: drizzle/rollback/0010_to_0009_down.sql permanece LOCKED.",
];

const HOSTNAME_LIKE = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9-]+)*\.[a-z]{2,24}$/i;

function usage() {
  return [
    "uso: node scripts/m02-neon-spend.mjs [--plan]",
    "  --plan  imprime o contrato de endpoints sem abrir socket (exit 0 sempre)",
    "  sem flags: exige NEON_API_KEY + NEON_PROJECT_ID; sem eles, SKIP rotulado (exit 0)",
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
 * Reduz um valor arbitrário a hostname — ou a null. URL com credencial vira
 * só o host; "user:pass@host/db" perde tudo menos o host; rótulos que não
 * terminam em TLD alfabético (datas, números de versão, nomes de branch) são
 * rejeitados, para que a saída seja hostnames e nada mais.
 */
function toHostname(value) {
  if (typeof value !== "string") return null;
  const raw = value.trim();
  if (raw === "") return null;
  if (raw.includes("://")) {
    try {
      return new URL(raw).hostname || null;
    } catch {
      return null;
    }
  }
  const afterCreds = raw.includes("@") ? raw.slice(raw.lastIndexOf("@") + 1) : raw;
  const host = afterCreds.split("/")[0].split(":")[0];
  return HOSTNAME_LIKE.test(host) ? host : null;
}

/** Coleta recursiva de hostnames de um payload — o payload em si nunca sai. */
function hostnamesOnly(payload) {
  const found = new Set();
  const walk = (value) => {
    if (typeof value === "string") {
      const host = toHostname(value);
      if (host !== null) found.add(host);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item);
      return;
    }
    if (value !== null && typeof value === "object") {
      for (const item of Object.values(value)) walk(item);
    }
  };
  walk(payload);
  return [...found].sort();
}

function pickNumber(source, field) {
  const value = source[field];
  return Number.isFinite(value) ? value : null;
}

function projectInventory(payload) {
  const project =
    payload !== null && typeof payload === "object" ? (payload.project ?? payload) : null;
  const source = project !== null && typeof project === "object" ? project : {};
  return {
    project_ref_present: true,
    org_ref_present: typeof source.org_id === "string" && source.org_id.trim() !== "",
    history_retention_seconds: Number.isInteger(source.history_retention_seconds)
      ? source.history_retention_seconds
      : null,
  };
}

function branchesInventory(payload) {
  const list = payload !== null && typeof payload === "object" ? payload.branches : undefined;
  const branches = Array.isArray(list)
    ? list.filter((b) => b !== null && typeof b === "object")
    : [];
  const usageFieldsPresent = new Set();
  const items = branches.map((branch) => {
    const usage = {};
    for (const field of BRANCH_USAGE_FIELDS) {
      const value = pickNumber(branch, field);
      usage[field] = value;
      if (value !== null) usageFieldsPresent.add(field);
    }
    return {
      name: typeof branch.name === "string" ? branch.name : null,
      primary: branch.primary === true,
      default: branch.default === true,
      created_at: typeof branch.created_at === "string" ? branch.created_at : null,
      usage,
    };
  });
  return {
    branches: {
      count: branches.length,
      primary_count: items.filter((item) => item.primary).length,
      items,
    },
    usage_fields_present: [...usageFieldsPresent].sort(),
    usage_fields_to_confirm: BRANCH_USAGE_FIELDS.filter((f) => !usageFieldsPresent.has(f)),
  };
}

function planReport() {
  return {
    check: "m02:neon-spend",
    mode: "plan",
    read_only: true,
    live_call: false,
    endpoints: [
      {
        method: "GET",
        path: "{NEON_API_BASE}/projects/{project_id}",
        used_for: "history_retention_seconds (inventário da janela de histórico)",
      },
      {
        method: "GET",
        path: "{NEON_API_BASE}/projects/{project_id}/branches",
        used_for:
          "inventário de branches (contagens; campos de consumo lidos SE presentes — TO-CONFIRM)",
      },
    ],
    not_attempted: [
      "spending_limit (PATCH/PUT de organização — H-4)",
      "consumption v2 (plano pago — H-4)",
    ],
    spending_guardrails: GUARDRAIL_LIMITS,
    exit_codes: { 0: "inventário OK ou SKIP rotulado", 2: "INCOMPLETE (fail-closed)" },
    notes: SCOPE_NOTES,
  };
}

function skipReport(missing) {
  return {
    check: "m02:neon-spend",
    mode: "run",
    read_only: true,
    live_call: false,
    result: "SKIP",
    skip_reason: `${missing.join(" + ")} ausente(s) no ambiente`,
    missing,
    detail:
      "NENHUMA chamada live foi feita: a janela de histórico e o inventário de branches NÃO foram medidos.",
    spending_guardrails: GUARDRAIL_LIMITS,
    notes: SCOPE_NOTES,
  };
}

function incompleteReport({ detail, httpStatus = null, apiBase, failedCall }) {
  return {
    check: "m02:neon-spend",
    mode: "run",
    read_only: true,
    live_call: true,
    result: "INCOMPLETE",
    fail_closed: true,
    failed_call: failedCall,
    http_status: httpStatus,
    api_base: apiBase,
    detail,
    spending_guardrails: GUARDRAIL_LIMITS,
    notes: SCOPE_NOTES,
  };
}

/** GET tipado com erro normalizado (nem token, nem payload bruto vazam). */
async function getJson({ fetchImpl, url, apiKey, label }) {
  let response;
  try {
    response = await fetchImpl(url, {
      method: "GET",
      headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    const message = redactSecret(error instanceof Error ? error.message : String(error), apiKey);
    return { ok: false, detail: `falha de rede/timeout em ${label}: ${message}` };
  }
  if (!response.ok) {
    return {
      ok: false,
      httpStatus: response.status,
      detail: `${label} devolveu HTTP ${response.status}`,
    };
  }
  try {
    return { ok: true, payload: await response.json() };
  } catch (error) {
    const message = redactSecret(error instanceof Error ? error.message : String(error), apiKey);
    return { ok: false, detail: `corpo de ${label} não é JSON: ${message}` };
  }
}

/**
 * Inventário injetável (fetch mockado nos testes). Devolve { report, exitCode }.
 * Duas chamadas, ambas GET; qualquer uma falhando → INCOMPLETE (fail-closed).
 */
async function checkSpend({ fetchImpl, apiBase = DEFAULT_API_BASE, projectId, apiKey }) {
  const encoded = encodeURIComponent(projectId);
  const startedAt = new Date().toISOString();
  const projectCall = await getJson({
    fetchImpl,
    url: `${apiBase}/projects/${encoded}`,
    apiKey,
    label: "GET /projects/{project_id}",
  });
  if (!projectCall.ok) {
    return {
      report: incompleteReport({
        detail: projectCall.detail,
        httpStatus: projectCall.httpStatus ?? null,
        apiBase,
        failedCall: "project",
      }),
      exitCode: 2,
    };
  }

  const branchesCall = await getJson({
    fetchImpl,
    url: `${apiBase}/projects/${encoded}/branches`,
    apiKey,
    label: "GET /projects/{project_id}/branches",
  });
  if (!branchesCall.ok) {
    return {
      report: incompleteReport({
        detail: branchesCall.detail,
        httpStatus: branchesCall.httpStatus ?? null,
        apiBase,
        failedCall: "branches",
      }),
      exitCode: 2,
    };
  }

  return {
    report: {
      check: "m02:neon-spend",
      mode: "run",
      read_only: true,
      live_call: true,
      started_at: startedAt,
      finished_at: new Date().toISOString(),
      result: "OK",
      source: "GET /projects/{project_id} + GET /projects/{project_id}/branches (Neon API v2)",
      ...projectInventory(projectCall.payload),
      ...branchesInventory(branchesCall.payload),
      hostnames: hostnamesOnly([projectCall.payload, branchesCall.payload]),
      spending_guardrails: GUARDRAIL_LIMITS,
      notes: SCOPE_NOTES,
    },
    exitCode: 0,
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
    emit(planReport());
    return;
  }
  const check = preflight(process.env);
  if (!check.ok) {
    emit(skipReport(check.missing));
    return; // exit 0: skip rotulado, nunca fail silencioso nem credencial improvisada
  }
  const { report, exitCode } = await checkSpend({
    fetchImpl: globalThis.fetch,
    apiBase: process.env.NEON_API_BASE || DEFAULT_API_BASE,
    projectId: process.env.NEON_PROJECT_ID,
    apiKey: process.env.NEON_API_KEY,
  });
  emit(report);
  process.exitCode = exitCode;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export {
  BRANCH_USAGE_FIELDS,
  DEFAULT_API_BASE,
  GUARDRAIL_LIMITS,
  SCOPE_NOTES,
  branchesInventory,
  checkSpend,
  hostnamesOnly,
  parseArgs,
  planReport,
  preflight,
  projectInventory,
  redactSecret,
  skipReport,
  toHostname,
};
