// m02-canonical-probe.ts — §13.6 (preparação do cutover): o CONJUNTO canônico de probes
// (live → ready → get-session) mais o par de controle de origem (positivo/negativo).
// SOMENTE LEITURA: GET nas health routes, get-session e POST de sign-in com credencial
// inexistente para exercitar o origin check. Não escreve arquivo, não muta dado.
//
// Por que o conjunto e não o `get-session` isolado (dia-d §1.6, correção S-TEC P1):
// `GET /api/auth/get-session` retorna 200 com corpo `null` em QUALQUER host, porque o
// `originCheckMiddleware` do better-auth retorna cedo em GET/HEAD/OPTIONS. Logo ele prova
// apenas que a instância de auth subiu (não é 500) — um `BETTER_AUTH_URL` obsoleto passa
// verde. A discriminação de origem exige POST; e a discriminação do VALOR de
// `BETTER_AUTH_URL` exige a asserção (c1) do host do link de reset de senha, que este
// script NÃO emite (depende de e-mail real — por isso a linha "troca de auth: NÃO
// CARIMBADA" é fixa na saída).
//
// Norma de segredos: nenhum valor de cookie/token entra na saída (só NOMES de cookie);
// nenhuma credencial real é usada (o POST leva e-mail e senha inexistentes).
//
// Uso:
//   node node_modules/tsx/dist/cli.mjs scripts/m02-canonical-probe.ts --base-url <url>
//        [--canonical-origin <origem>] [--wrong-origin <origem>]
//        [--samples <n>] [--max-time-ms <n>]
//
// Exit codes: 0 = PASS · 1 = FAIL de asserção · 2 = INCONCLUSIVO (alvo inalcançável ou 429
// mascarando o veredito de origem) ou uso inválido.
// As latências medidas aqui são LOCAIS/CONTROLADAS — nunca rotular como produção.

interface Note {
  id: string;
  expectation: string;
  observed: string;
  status: "PASS" | "FAIL" | "INCONCLUSIVO" | "INFO";
}

interface ProbeArgs {
  baseUrl: string;
  canonicalOrigin: string;
  wrongOrigin: string;
  samples: number;
  maxTimeMs: number;
  bucketIp?: string;
}

const USAGE =
  "uso: node node_modules/tsx/dist/cli.mjs scripts/m02-canonical-probe.ts --base-url <url> " +
  "[--canonical-origin <origem>] [--wrong-origin <origem>] [--samples <n>] [--max-time-ms <n>] " +
  "[--bucket-ip <ipv4>]";

function usageError(message: string): never {
  console.error(`m02-canonical-probe: ${message}`);
  console.error(USAGE);
  process.exit(2);
}

function parseArgs(argv: string[]): ProbeArgs {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (!arg.startsWith("--")) usageError(`argumento desconhecido: ${arg}`);
    const value = argv[index + 1];
    if (!value) usageError(`${arg} exige um valor`);
    values.set(arg, value);
    index += 1;
  }
  const baseUrl = values.get("--base-url");
  if (!baseUrl) usageError("--base-url é obrigatório");
  const samples = Number(values.get("--samples") ?? "3");
  const maxTimeMs = Number(values.get("--max-time-ms") ?? "3000");
  if (!Number.isInteger(samples) || samples < 1) usageError("--samples deve ser inteiro ≥ 1");
  if (!Number.isFinite(maxTimeMs) || maxTimeMs < 1) usageError("--max-time-ms inválido");
  // Espelha o idioma de `auth-policy.ts` (parseOrigin): uma entrada malformada
  // vira erro de uso (exit 2), nunca um TypeError cru.
  let origin: string;
  try {
    origin = new URL(baseUrl).origin;
  } catch {
    usageError(`--base-url não é uma URL válida: ${baseUrl}`);
  }
  return {
    baseUrl: baseUrl.replace(/\/$/, ""),
    canonicalOrigin: values.get("--canonical-origin") ?? origin,
    wrongOrigin: values.get("--wrong-origin") ?? "https://example.invalid",
    samples,
    maxTimeMs,
    bucketIp: values.get("--bucket-ip"),
  };
}

function cookieNames(response: Response): string {
  const raw = response.headers.getSetCookie?.() ?? [];
  const names = raw.map((cookie) => cookie.split("=")[0]?.trim() ?? "").filter(Boolean);
  return names.length ? names.join(", ") : "(nenhum)";
}

function summariseBody(text: string): string {
  const trimmed = text.trim().replace(/[A-Za-z0-9._-]{32,}/g, "[valor-redigido]");
  const compact = trimmed.slice(0, 80);
  return compact.length ? compact : "(vazio)";
}

async function request(
  args: ProbeArgs,
  path: string,
  init: RequestInit = {},
): Promise<{ response: Response; body: string; elapsedMs: number }> {
  const started = performance.now();
  const response = await fetch(`${args.baseUrl}${path}`, {
    ...init,
    redirect: "manual",
    signal: AbortSignal.timeout(args.maxTimeMs),
  });
  const body = await response.text();
  return { response, body, elapsedMs: Math.round(performance.now() - started) };
}

async function getCheck(args: ProbeArgs, id: string, path: string, notes: Note[]): Promise<void> {
  const latencies: number[] = [];
  let lastStatus = 0;
  let lastBody = "";
  for (let sample = 1; sample <= args.samples; sample += 1) {
    const { response, body, elapsedMs } = await request(args, path);
    latencies.push(elapsedMs);
    lastStatus = response.status;
    lastBody = body;
    if (response.status !== 200) break;
  }
  const expectedBody = id === "live" ? /"status"\s*:\s*"ok"/ : /"postgres"\s*:\s*"ok"/;
  const ok = lastStatus === 200 && expectedBody.test(lastBody);
  notes.push({
    id,
    expectation: `GET ${path} → 200 e corpo esperado (${args.samples} amostra(s))`,
    observed: `status=${lastStatus} body=${summariseBody(lastBody)} latencias_ms=[${latencies.join(", ")}]`,
    status: ok ? "PASS" : "FAIL",
  });
}

// O bucket `/sign-in/email` é 5 tentativas/min por IP (rate-limit-rules.server.ts); o
// conjunto abaixo gasta 4 POSTs. 429 mascara o veredito de origem → INCONCLUSIVO, nunca
// FAIL nem PASS: aguardar a janela e re-executar.
const SIGN_IN_BUCKET_HINT =
  "429 do bucket /sign-in/email (5/min por IP): veredito de origem MASCARADO — aguarde a janela e re-execute";

async function signInProbe(
  args: ProbeArgs,
  id: string,
  options: { origin?: string; cookie?: boolean; expect: "403" | "not-403"; expectation: string },
  notes: Note[],
): Promise<void> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (options.origin) headers.origin = options.origin;
  if (options.cookie) headers.cookie = "preco_que_da_lucro.session_token=probe-invalido";
  // `--bucket-ip` existe só para execução controlada: sem header de IP e fora de
  // dev/test o better-auth resolve `getIP` para null e TODOS os clientes caem no mesmo
  // bucket `no-trusted-ip|<path>` (5/min). Na janela real o flag fica de fora.
  if (args.bucketIp) headers["x-forwarded-for"] = args.bucketIp;
  const path = "/api/auth/sign-in/email";
  const { response, body, elapsedMs } = await request(args, path, {
    method: "POST",
    headers,
    body: JSON.stringify({
      email: "probe-inexistente@example.invalid",
      password: "credencial-inexistente-do-probe",
    }),
  });
  const ok =
    options.expect === "403"
      ? response.status === 403
      : response.status !== 403 && response.status < 500;
  const status = response.status === 429 ? "INCONCLUSIVO" : ok ? "PASS" : "FAIL";
  notes.push({
    id,
    expectation: `POST ${path} ${options.expectation}`,
    observed:
      `status=${response.status} body=${summariseBody(body)} cookies=[${cookieNames(response)}] latencia_ms=${elapsedMs}` +
      (status === "INCONCLUSIVO" ? ` — ${SIGN_IN_BUCKET_HINT}` : ""),
    status,
  });
}

function render(args: ProbeArgs, notes: Note[]): string {
  const width = Math.max(...notes.map((note) => note.id.length));
  return [
    "m02-canonical-probe — §13.6 conjunto canônico + controle de origem",
    `alvo: ${args.baseUrl} (origem canônica do probe: ${args.canonicalOrigin})`,
    `limite por requisição: ${args.maxTimeMs} ms · amostras de live/ready: ${args.samples}`,
    "latências abaixo são LOCAIS/CONTROLADAS — não são números de produção",
    "",
    ...notes.map(
      (note) =>
        `${note.id.padEnd(width)}  ${note.status.padEnd(4)}  ${note.expectation}\n` +
        `${" ".repeat(width)}        observado: ${note.observed}`,
    ),
    "",
    "get-session: NÃO discrimina a troca de auth (origin check retorna cedo em GET/HEAD/OPTIONS).",
    "troca de auth: NÃO CARIMBADA por este probe — exige a asserção (c1) do host do link de reset",
    "de senha, emitida por e-mail controlado no canônico (dia-d §1.6-c1/c2).",
    `custo do conjunto: 5 POSTs em /sign-in/email — bucket 5/min por IP${args.bucketIp ? ` (isolado em ${args.bucketIp})` : " (sem isolamento: todos os clientes locais compartilham o bucket)"}.`,
  ].join("\n");
}

const args = parseArgs(process.argv.slice(2));
const notes: Note[] = [];

try {
  const warmUp = await request(args, "/api/health/live");
  notes.push({
    id: "warm-up",
    expectation: "GET /api/health/live paga o TTFF a frio (não é asserção)",
    observed: `status=${warmUp.response.status} latencia_ms=${warmUp.elapsedMs}`,
    status: "INFO",
  });
  await getCheck(args, "live", "/api/health/live", notes);
  await getCheck(args, "ready", "/api/health/ready", notes);

  const session = await request(args, "/api/auth/get-session");
  const sessionBody = session.body.trim();
  notes.push({
    id: "get-session",
    expectation: "GET /api/auth/get-session → 200 e corpo `null` (prova só que a instância subiu)",
    observed: `status=${session.response.status} body=${summariseBody(sessionBody)} latencia_ms=${session.elapsedMs}`,
    status: session.response.status === 200 && sessionBody === "null" ? "PASS" : "FAIL",
  });

  await signInProbe(
    args,
    "origem-positiva",
    {
      origin: args.canonicalOrigin,
      expect: "not-403",
      expectation: "com Origin canônico → ≠403 (sem este PASS o controle negativo não vale)",
    },
    notes,
  );
  await signInProbe(
    args,
    "origem-negativa",
    { origin: args.wrongOrigin, expect: "403", expectation: "com Origin não confiável → 403" },
    notes,
  );
  await signInProbe(
    args,
    "origem-negativa-cookie",
    {
      origin: args.wrongOrigin,
      cookie: true,
      expect: "403",
      expectation:
        "com Origin não confiável e cookie → 403 (caminho `useCookies` do validateOrigin)",
    },
    notes,
  );
  await signInProbe(
    args,
    "origem-positiva-cookie",
    {
      origin: args.canonicalOrigin,
      cookie: true,
      expect: "not-403",
      expectation: "com Origin canônico e cookie → ≠403 (par do controle negativo com cookie)",
    },
    notes,
  );

  const semOrigem = await request(args, "/api/auth/sign-in/email", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(args.bucketIp ? { "x-forwarded-for": args.bucketIp } : {}),
    },
    body: JSON.stringify({
      email: "probe-inexistente@example.invalid",
      password: "credencial-inexistente-do-probe",
    }),
  });
  notes.push({
    id: "origem-ausente",
    expectation:
      "POST sem Origin nem cookie → INFO, não asserção (o veredito depende dos headers Sec-Fetch-* do cliente)",
    observed: `status=${semOrigem.response.status} body=${summariseBody(semOrigem.body)}`,
    status: "INFO",
  });
} catch (error) {
  notes.push({
    id: "transporte",
    expectation: "alvo alcançável",
    observed: `erro: ${error instanceof Error ? error.name : "desconhecido"}`,
    status: "INCONCLUSIVO",
  });
  console.log(render(args, notes));
  console.log("RESULTADO: INCONCLUSIVO — alvo inalcançável: nenhuma asserção foi avaliada.");
  process.exit(2);
}

console.log(render(args, notes));
const failed = notes.some((note) => note.status === "FAIL");
const inconclusive = notes.some((note) => note.status === "INCONCLUSIVO");
if (inconclusive && !failed) {
  console.log("RESULTADO: INCONCLUSIVO — a origem NÃO foi provada nesta execução (429 mascarou).");
}
process.exit(failed ? 1 : inconclusive ? 2 : 0);

export {};
