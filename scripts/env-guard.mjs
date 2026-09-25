// ENV-GUARD — default-DENY para banco remoto em scripts de teste/dev/mutação.
// Norma: docs/specs/M-02/emenda-2026-09-07-env-guard.md
// Design: docs/evidence/gsec-2026-09-06/designs-endurecimento.md (§T2.1)
//
// Contrato:
//   exit 0 = allow | exit 3 = deny | exit 2 = erro interno (fail-closed).
//   Este guard NUNCA conecta a nada: apenas inspeciona variáveis de ambiente
//   em memória. NUNCA imprime valores de env — somente hostnames.
//   Selftest (`--selftest`) roda a matriz com envs sintéticas em memória.

const GUARD = "env-guard";
const NORMA_PATH = "docs/specs/M-02/emenda-2026-09-07-env-guard.md";

/** Scripts que NUNCA podem falar com banco de hostname não-local. */
const DENY_SET = new Set([
  "test",
  "dev",
  "build:dev",
  "e2e:prepare",
  "test:e2e",
  "db:test",
  "db:migrate",
  "db:generate",
  "db:check",
]);

/** Allowlist de ops sancionadas (produção read-only ou drill autorizado). */
const SANCTIONED_REMOTE = new Set([
  "smoke:substrate",
  "m02:readiness",
  "m02:backup-verify",
  "m02:grant-repair",
  "m02:rls-probe",
  "migration:legacy-to-neon",
  "m02:env-guard-selftest",
  "m02:snapshot",
]);

const DB_ENV_VARS = [
  "DATABASE_URL",
  "DATABASE_URL_UNPOOLED",
  "DATABASE_ADMIN_URL",
  "DATABASE_RESTORE_URL",
];

const LOCAL_HOSTNAMES = new Set(["127.0.0.1", "localhost", "::1"]);
const OVERRIDE_ENV = "ALLOW_REMOTE_DB";
// Endpoints de PRODUÇÃO (hard-deny; emenda #2): prefixo do endpoint id cobre
// as variantes direct e -pooler. Nada permite migração contra eles.
const PRODUCTION_ENDPOINT_PREFIX = "ep-long-violet-aye9g0bn";
const DRILL_BRANCH_KIND = "drill-branch";
const CUTOVER_WINDOW_KIND = "cutover-window";

const EXIT_ALLOW = 0;
const EXIT_TEST_FAILURE = 1; // exclusivo do selftest com caso reprovado
const EXIT_INTERNAL_ERROR = 2;
const EXIT_DENY = 3;

/**
 * Classifica uma env de conexão sem nunca ecoar o valor.
 * @returns {{status: "unset"|"local"|"remote"|"malformed", host: string|null}}
 */
function classifyDbEnv(rawValue) {
  if (rawValue === undefined) return { status: "unset", host: null };
  let parsed;
  try {
    parsed = new URL(rawValue);
  } catch {
    // Fail-closed: URL malformada é tratada como host indeterminado.
    return { status: "malformed", host: null };
  }
  const host = parsed.hostname.replace(/^\[/, "").replace(/\]$/, "").toLowerCase();
  if (host === "") return { status: "malformed", host: null };
  if (LOCAL_HOSTNAMES.has(host)) return { status: "local", host };
  return { status: "remote", host };
}

/**
 * Resolve o script alvo: `--script=<nome>` (CLI) tem precedência; sem ele,
 * `npm_lifecycle_event`. Hooks `pre*` do npm são normalizados (ex.:
 * `pretest` → `test`, `predb:test` → `db:test`) quando o sufixo é um script
 * conhecido; casos como `preview` ficam intactos.
 */
function resolveTargetScript(lifecycleEvent, cliScript) {
  const raw = cliScript !== undefined ? cliScript : lifecycleEvent;
  if (typeof raw !== "string") return undefined;
  const name = raw.trim();
  if (name === "") return undefined;
  if (name.startsWith("pre")) {
    const target = name.slice(3);
    if (DENY_SET.has(target) || SANCTIONED_REMOTE.has(target)) return target;
  }
  return name;
}

function remedioFor(script) {
  if (script === "db:migrate") {
    return (
      "migração contra banco remoto exige MIGRATION_APPLY + manifest próprio; " +
      "exceções: (a) branch de drill Neon (NEON_MIGRATION_TARGET_KIND=drill-branch + " +
      "ALLOW_REMOTE_DB=<motivo>, host ≠ produção — emenda #2); (b) janela de freeze do " +
      "cutover (NEON_MIGRATION_TARGET_KIND=cutover-window + ALLOW_REMOTE_DB + " +
      "NEON_MIGRATION_FREEZE_START/END válidas e vigentes — emenda #3). " +
      "Para desenvolvimento usar banco local (npm run db:up) + .env local"
    );
  }
  return "usar banco local (npm run db:up) + .env local";
}

/**
 * Emenda #3: valida a janela de freeze do cutover (padrão expiresOn do
 * WARN-NITRO-001). Datas ISO 8601; "agora" deve estar dentro de [start, end].
 * @returns {{ok: boolean, freezeStart: string|null, freezeEnd: string|null, reason: string}}
 */
function validateFreezeWindow(env, now = new Date()) {
  const freezeStart = env.NEON_MIGRATION_FREEZE_START;
  const freezeEnd = env.NEON_MIGRATION_FREEZE_END;
  const start = typeof freezeStart === "string" ? new Date(freezeStart) : null;
  const end = typeof freezeEnd === "string" ? new Date(freezeEnd) : null;
  if (
    !start ||
    !end ||
    Number.isNaN(start.getTime()) ||
    Number.isNaN(end.getTime()) ||
    start.getTime() >= end.getTime()
  ) {
    return {
      ok: false,
      freezeStart: null,
      freezeEnd: null,
      reason: "janela de freeze ausente/malformada (ISO 8601 exigido)",
    };
  }
  const time = now.getTime();
  if (time < start.getTime()) {
    return { ok: false, freezeStart, freezeEnd, reason: "freeze ainda não começou" };
  }
  if (time > end.getTime()) {
    return { ok: false, freezeStart, freezeEnd, reason: "freeze expirado" };
  }
  return { ok: true, freezeStart, freezeEnd, reason: "dentro da janela" };
}

function denyLine(script, envName, host, remedio) {
  return {
    stream: "stderr",
    payload: {
      guard: GUARD,
      result: "DENY",
      script,
      env: envName,
      host,
      remedio,
      norma: NORMA_PATH,
    },
  };
}

function allowDecision(lines = []) {
  return { result: "ALLOW", exitCode: EXIT_ALLOW, lines };
}

function cutoverMigrationDecision(env, script, envName, cls) {
  const motivo = env[OVERRIDE_ENV];
  const janela = validateFreezeWindow(env);
  if (janela.ok && typeof motivo === "string" && motivo.trim() !== "") {
    return {
      result: "ALLOW",
      exitCode: EXIT_ALLOW,
      overrideApplied: true,
      lines: [
        {
          stream: "stderr",
          payload: {
            guard: GUARD,
            result: "ALLOW",
            path: CUTOVER_WINDOW_KIND,
            script,
            env: envName,
            host: cls.host,
            freezeStart: janela.freezeStart,
            freezeEnd: janela.freezeEnd,
            motivo: motivo.trim(),
            norma: NORMA_PATH,
          },
        },
      ],
    };
  }
  return {
    result: "DENY",
    exitCode: EXIT_DENY,
    lines: [
      denyLine(script, envName, cls.host, `cutover-window recusado: ${janela.reason} (emenda #3)`),
    ],
  };
}

function drillMigrationDecision(env, script, envName, cls) {
  const isProductionHost = cls.host !== null && cls.host.includes(PRODUCTION_ENDPOINT_PREFIX);
  const motivo = env[OVERRIDE_ENV];
  if (
    !isProductionHost &&
    env.NEON_MIGRATION_TARGET_KIND === DRILL_BRANCH_KIND &&
    typeof motivo === "string" &&
    motivo.trim() !== ""
  ) {
    return {
      result: "ALLOW",
      exitCode: EXIT_ALLOW,
      overrideApplied: true,
      lines: [
        {
          stream: "stderr",
          payload: {
            guard: GUARD,
            result: "ALLOW",
            path: DRILL_BRANCH_KIND,
            script,
            env: envName,
            host: cls.host,
            motivo: motivo.trim(),
            norma: NORMA_PATH,
          },
        },
      ],
    };
  }
  return {
    result: "DENY",
    exitCode: EXIT_DENY,
    lines: [denyLine(script, envName, cls.host, remedioFor(script))],
  };
}

function migrationDecision(env, script, envName, cls) {
  if (env.NEON_MIGRATION_TARGET_KIND === CUTOVER_WINDOW_KIND) {
    return cutoverMigrationDecision(env, script, envName, cls);
  }
  return drillMigrationDecision(env, script, envName, cls);
}

function overrideDecision(env, script, envName, cls) {
  const motivo = env[OVERRIDE_ENV];
  if (typeof motivo === "string" && motivo.trim() !== "") {
    return {
      result: "ALLOW",
      exitCode: EXIT_ALLOW,
      overrideApplied: true,
      lines: [
        {
          stream: "stderr",
          payload: {
            guard: GUARD,
            result: "ALLOW",
            override: true,
            script,
            env: envName,
            host: cls.host,
            motivo: motivo.trim(),
          },
        },
      ],
    };
  }
  return {
    result: "DENY",
    exitCode: EXIT_DENY,
    lines: [denyLine(script, envName, cls.host, remedioFor(script))],
  };
}

function decisionForDatabaseValue(env, script, envName) {
  const cls = classifyDbEnv(env[envName]);
  if (cls.status === "unset" || cls.status === "local") return null;
  if (cls.status === "malformed") {
    return {
      result: "DENY",
      exitCode: EXIT_DENY,
      lines: [
        denyLine(
          script,
          envName,
          null,
          `${remedioFor(script)} (URL malformada; fail-closed, valor omitido)`,
        ),
      ],
    };
  }
  return script === "db:migrate"
    ? migrationDecision(env, script, envName, cls)
    : overrideDecision(env, script, envName, cls);
}

function deniedScriptDecision(env, script) {
  for (const envName of DB_ENV_VARS) {
    const decision = decisionForDatabaseValue(env, script, envName);
    if (decision !== null) return decision;
  }
  return allowDecision();
}

function sanctionedRemoteDecision(env, script) {
  for (const envName of DB_ENV_VARS) {
    const cls = classifyDbEnv(env[envName]);
    if (cls.status !== "remote") continue;
    return allowDecision([
      {
        stream: "stderr",
        payload: {
          guard: GUARD,
          result: "ALLOW_SANCTIONED",
          script,
          env: envName,
          host: cls.host,
          norma: NORMA_PATH,
        },
      },
    ]);
  }
  return allowDecision();
}

/**
 * Decisão pura do guard sobre um record de env (nunca conecta, nunca lê disco).
 * @returns {{result: "ALLOW"|"DENY", exitCode: number, overrideApplied?: boolean,
 *            lines: Array<{stream: "stdout"|"stderr", payload: object}>}}
 */
function guardDecision(env, cliScript) {
  try {
    const script = resolveTargetScript(env.npm_lifecycle_event, cliScript);
    if (script === undefined) return allowDecision();
    if (DENY_SET.has(script)) return deniedScriptDecision(env, script);
    if (SANCTIONED_REMOTE.has(script)) return sanctionedRemoteDecision(env, script);
    return allowDecision();
  } catch (error) {
    return {
      result: "DENY",
      exitCode: EXIT_INTERNAL_ERROR,
      lines: [
        {
          stream: "stderr",
          payload: {
            guard: GUARD,
            result: "ERROR",
            error: safeMessage(error),
            norma: NORMA_PATH,
          },
        },
      ],
    };
  }
}

/** Nunca ecoar algo que possa conter URL/credencial. */
function safeMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  if (message.includes("://") || message.includes("@")) {
    return "erro interno (detalhes omitidos)";
  }
  return message.slice(0, 200);
}

function printLines(lines) {
  for (const { stream, payload } of lines) {
    const text = `${JSON.stringify(payload)}\n`;
    if (stream === "stdout") process.stdout.write(text);
    else process.stderr.write(text);
  }
}

function parseArgs(argv) {
  let selftest = false;
  let script;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--selftest") {
      selftest = true;
      continue;
    }
    if (arg.startsWith("--script=")) {
      const value = arg.slice("--script=".length).trim();
      if (value === "") return { error: "argumento --script exige valor não-vazio" };
      script = value;
      continue;
    }
    if (arg === "--script") {
      const value = (argv[index + 1] ?? "").trim();
      if (value === "") return { error: "argumento --script exige valor não-vazio" };
      script = value;
      index += 1;
      continue;
    }
    return { error: `argumento não reconhecido: ${arg}` };
  }
  return { selftest, script };
}

const SELFTEST_CASES = [
  {
    name: "local+test",
    script: "test",
    env: { DATABASE_URL: "postgresql://postgres:postgres@127.0.0.1:5432/app" },
    expected: "ALLOW",
  },
  {
    name: "remoto+test",
    script: "test",
    env: { DATABASE_URL: "postgresql://127.0.0.1:5432/preco_test" },
    expected: "DENY",
  },
  {
    name: "remoto+smoke:substrate",
    script: "smoke:substrate",
    env: { DATABASE_URL: "postgresql://127.0.0.1:5432/preco_test" },
    expected: "ALLOW",
  },
  {
    name: "remoto+test+ALLOW_REMOTE_DB",
    script: "test",
    env: {
      DATABASE_URL: "postgresql://127.0.0.1:5432/preco_test",
      ALLOW_REMOTE_DB: "teste interno",
    },
    expected: "ALLOW+override-log",
  },
  {
    name: "remoto+db:migrate+ALLOW_REMOTE_DB",
    script: "db:migrate",
    env: {
      DATABASE_URL: "postgresql://127.0.0.1:5432/preco_test",
      ALLOW_REMOTE_DB: "teste interno",
    },
    expected: "DENY",
  },
  {
    name: "malformada+test",
    script: "test",
    env: { DATABASE_URL: "not-a-url" },
    expected: "DENY",
  },
  {
    name: "drill-branch+db:migrate+ALLOW_REMOTE_DB",
    script: "db:migrate",
    env: {
      DATABASE_URL: "postgresql://127.0.0.1:5432/preco_test",
      ALLOW_REMOTE_DB: "dry-run V2 CUTOVER-READY",
      NEON_MIGRATION_TARGET_KIND: "drill-branch",
    },
    expected: "ALLOW+override-log",
  },
  {
    name: "producao+db:migrate+drill-branch",
    script: "db:migrate",
    env: {
      DATABASE_URL: "postgresql://127.0.0.1:5432/preco_test",
      ALLOW_REMOTE_DB: "dry-run V2 CUTOVER-READY",
      NEON_MIGRATION_TARGET_KIND: "drill-branch",
    },
    expected: "DENY",
  },
  {
    name: "cutover-window+producao+janela-vigente",
    script: "db:migrate",
    env: {
      DATABASE_URL: "postgresql://127.0.0.1:5432/preco_test",
      ALLOW_REMOTE_DB: "migração T-0 do cutover A4",
      NEON_MIGRATION_TARGET_KIND: "cutover-window",
      NEON_MIGRATION_FREEZE_START: new Date(Date.now() - 60_000).toISOString(),
      NEON_MIGRATION_FREEZE_END: new Date(Date.now() + 3_600_000).toISOString(),
    },
    expected: "ALLOW+override-log",
  },
  {
    name: "cutover-window+producao+janela-expirada",
    script: "db:migrate",
    env: {
      DATABASE_URL: "postgresql://127.0.0.1:5432/preco_test",
      ALLOW_REMOTE_DB: "migração T-0 do cutover A4",
      NEON_MIGRATION_TARGET_KIND: "cutover-window",
      NEON_MIGRATION_FREEZE_START: new Date(Date.now() - 7_200_000).toISOString(),
      NEON_MIGRATION_FREEZE_END: new Date(Date.now() - 60_000).toISOString(),
    },
    expected: "DENY",
  },
  {
    name: "cutover-window+producao+sem-override",
    script: "db:migrate",
    env: {
      DATABASE_URL: "postgresql://127.0.0.1:5432/preco_test",
      NEON_MIGRATION_TARGET_KIND: "cutover-window",
      NEON_MIGRATION_FREEZE_START: new Date(Date.now() - 60_000).toISOString(),
      NEON_MIGRATION_FREEZE_END: new Date(Date.now() + 3_600_000).toISOString(),
    },
    expected: "DENY",
  },
  {
    name: "sem envs+test",
    script: "test",
    env: {},
    expected: "ALLOW",
  },
  {
    name: "remoto+m02:snapshot",
    script: "m02:snapshot",
    env: { DATABASE_ADMIN_URL: "postgresql://127.0.0.1:5432/preco_test" },
    expected: "ALLOW",
  },
];

const MANAGED_KEYS = [
  ...DB_ENV_VARS,
  OVERRIDE_ENV,
  "NEON_MIGRATION_TARGET_KIND",
  "NEON_MIGRATION_FREEZE_START",
  "NEON_MIGRATION_FREEZE_END",
  "SUPABASE_MIGRATION_DATABASE_URL",
  "npm_lifecycle_event",
];

function runSelftest() {
  // Salva o estado real das chaves gerenciadas para restaurar no fim.
  const snapshot = new Map();
  for (const key of MANAGED_KEYS) {
    snapshot.set(key, Object.hasOwn(process.env, key) ? process.env[key] : undefined);
  }
  let failures = 0;
  try {
    for (const testCase of SELFTEST_CASES) {
      for (const key of MANAGED_KEYS) delete process.env[key];
      process.env.npm_lifecycle_event = testCase.script;
      for (const [key, value] of Object.entries(testCase.env)) process.env[key] = value;

      const decision = guardDecision(process.env);
      const got =
        decision.result === "ALLOW" && decision.overrideApplied
          ? "ALLOW+override-log"
          : decision.result;
      const exitOk = decision.exitCode === (decision.result === "DENY" ? EXIT_DENY : EXIT_ALLOW);
      const pass = got === testCase.expected && exitOk;
      if (!pass) failures += 1;
      process.stdout.write(
        `${JSON.stringify({ case: testCase.name, expected: testCase.expected, got, pass })}\n`,
      );
    }
  } finally {
    for (const [key, value] of snapshot) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
  process.stdout.write(
    `${JSON.stringify({
      guard: GUARD,
      selftest: "summary",
      total: SELFTEST_CASES.length,
      failed: failures,
      pass: failures === 0,
    })}\n`,
  );
  return failures === 0 ? EXIT_ALLOW : EXIT_TEST_FAILURE;
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error !== undefined) {
    printLines([
      {
        stream: "stderr",
        payload: { guard: GUARD, result: "ERROR", error: parsed.error, norma: NORMA_PATH },
      },
    ]);
    process.exitCode = EXIT_INTERNAL_ERROR;
    return;
  }
  if (parsed.selftest) {
    process.exitCode = runSelftest();
    return;
  }
  const decision = guardDecision(process.env, parsed.script);
  printLines(decision.lines);
  process.exitCode = decision.exitCode;
}

try {
  main();
} catch (error) {
  printLines([
    {
      stream: "stderr",
      payload: { guard: GUARD, result: "ERROR", error: safeMessage(error), norma: NORMA_PATH },
    },
  ]);
  process.exitCode = EXIT_INTERNAL_ERROR;
}
