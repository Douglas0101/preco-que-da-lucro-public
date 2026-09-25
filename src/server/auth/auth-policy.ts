export interface AuthRuntimePolicy {
  baseURL?: string;
  trustedOrigins: string[];
  secureCookies: boolean;
  sessionCookieName: string;
}

function parseOrigin(value: string, variableName: string): string {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${variableName} contém uma URL inválida`);
  }

  if (
    parsed.protocol !== "https:" &&
    parsed.hostname !== "localhost" &&
    parsed.hostname !== "127.0.0.1"
  ) {
    throw new Error(`${variableName} deve usar HTTPS fora do ambiente local`);
  }
  if (
    parsed.pathname !== "/" ||
    parsed.search ||
    parsed.hash ||
    parsed.username ||
    parsed.password
  ) {
    throw new Error(`${variableName} deve conter somente a origem, sem path, credencial ou query`);
  }
  return parsed.origin;
}

export function resolveAuthPolicy(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AuthRuntimePolicy {
  const production = environment.NODE_ENV === "production";
  const baseURL = environment.BETTER_AUTH_URL
    ? parseOrigin(environment.BETTER_AUTH_URL, "BETTER_AUTH_URL")
    : undefined;

  if (production && !baseURL) {
    throw new Error("BETTER_AUTH_URL é obrigatória em produção");
  }

  const configuredOrigins = (environment.AUTH_TRUSTED_ORIGINS ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean)
    .map((value) => parseOrigin(value, "AUTH_TRUSTED_ORIGINS"));

  const localOrigins = production
    ? []
    : [
        "http://localhost:3000",
        "http://localhost:4173",
        "http://127.0.0.1:3000",
        "http://127.0.0.1:4173",
      ];

  return {
    baseURL,
    trustedOrigins: [
      ...new Set([...(baseURL ? [baseURL] : []), ...configuredOrigins, ...localOrigins]),
    ],
    secureCookies: production,
    sessionCookieName: production
      ? "__Host-preco_que_da_lucro.session_token"
      : "preco_que_da_lucro.session_token",
  };
}

// §13.6 (preparação do cutover): pré-voo por NOME/ESTADO para `scripts/m02-auth-preflight.ts`.
// As três funções de política acima continuam sendo a fonte única do veredito — este relatório
// apenas as exercita sobre o ambiente do alvo e devolve nome, presença e veredito. Nenhum campo
// carrega valor: `detail` só reproduz mensagens de política (que citam a variável, nunca o
// conteúdo) ou contagens derivadas.
export type AuthEnvPresence = "present" | "empty" | "absent";
export type AuthEnvRequirement =
  "required" | "required-in-production" | "optional" | "optional-pair";
export type AuthEnvVerdict = "ok" | "invalid" | "missing" | "incomplete" | "not-configured";

export interface AuthEnvEntry {
  name: string;
  presence: AuthEnvPresence;
  requirement: AuthEnvRequirement;
  verdict: AuthEnvVerdict;
  detail: string;
}

export function authEnvPresence(value: string | undefined): AuthEnvPresence {
  if (value === undefined) return "absent";
  return value.trim() ? "present" : "empty";
}

function policyMessage(error: unknown): string {
  return error instanceof Error ? error.message : "erro de política sem mensagem";
}

function baseUrlEntry(
  environment: Readonly<Record<string, string | undefined>>,
  production: boolean,
): AuthEnvEntry {
  const value = environment.BETTER_AUTH_URL;
  const entry = {
    name: "BETTER_AUTH_URL",
    presence: authEnvPresence(value),
    requirement: "required-in-production" as const,
  };
  if (!value?.trim()) {
    return {
      ...entry,
      verdict: production ? "missing" : "not-configured",
      detail: production ? "obrigatória em produção" : "ausente fora de produção",
    };
  }
  try {
    parseOrigin(value, "BETTER_AUTH_URL");
    return { ...entry, verdict: "ok", detail: "origem aceita pela política" };
  } catch (error) {
    return { ...entry, verdict: "invalid", detail: policyMessage(error) };
  }
}

function trustedOriginsEntry(
  environment: Readonly<Record<string, string | undefined>>,
): AuthEnvEntry {
  const value = environment.AUTH_TRUSTED_ORIGINS;
  const entry = {
    name: "AUTH_TRUSTED_ORIGINS",
    presence: authEnvPresence(value),
    requirement: "optional" as const,
  };
  const configured = (value ?? "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  try {
    for (const origin of configured) parseOrigin(origin, "AUTH_TRUSTED_ORIGINS");
  } catch (error) {
    return { ...entry, verdict: "invalid", detail: policyMessage(error) };
  }
  if (configured.length === 0) {
    return {
      ...entry,
      verdict: "not-configured",
      detail: "lista vazia; baseURL entra automaticamente",
    };
  }
  return { ...entry, verdict: "ok", detail: `${configured.length} origem(ns) válida(s)` };
}

function secretEntry(environment: Readonly<Record<string, string | undefined>>): AuthEnvEntry {
  const entry = {
    name: "BETTER_AUTH_SECRET",
    presence: authEnvPresence(environment.BETTER_AUTH_SECRET),
    requirement: "required" as const,
  };
  if (entry.presence !== "present") return { ...entry, verdict: "missing", detail: "obrigatória" };
  try {
    requireAuthSecret(environment);
    return { ...entry, verdict: "ok", detail: "mínimo de 32 caracteres atendido" };
  } catch (error) {
    return { ...entry, verdict: "invalid", detail: policyMessage(error) };
  }
}

function googleEntries(environment: Readonly<Record<string, string | undefined>>): AuthEnvEntry[] {
  let resolved: { clientId: string; clientSecret: string } | undefined;
  let failure: string | undefined;
  try {
    resolved = resolveGoogleCredentials(environment);
  } catch (error) {
    failure = policyMessage(error);
  }
  const verdict: AuthEnvVerdict = failure ? "incomplete" : resolved ? "ok" : "not-configured";
  const detail =
    failure ?? (resolved ? "par completo (id e segredo presentes)" : "provider Google desativado");
  return (["GOOGLE_CLIENT_ID", "GOOGLE_CLIENT_SECRET"] as const).map((name) => ({
    name,
    presence: authEnvPresence(environment[name]),
    requirement: "optional-pair" as const,
    verdict,
    detail,
  }));
}

export function describeAuthEnv(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): AuthEnvEntry[] {
  const production = environment.NODE_ENV === "production";
  return [
    baseUrlEntry(environment, production),
    trustedOriginsEntry(environment),
    secretEntry(environment),
    ...googleEntries(environment),
  ];
}

export function requireAuthSecret(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string {
  const secret = environment.BETTER_AUTH_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error("BETTER_AUTH_SECRET deve ter pelo menos 32 caracteres");
  }
  return secret;
}

export function resolveGoogleCredentials(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): { clientId: string; clientSecret: string } | undefined {
  const clientId = environment.GOOGLE_CLIENT_ID;
  const clientSecret = environment.GOOGLE_CLIENT_SECRET;
  if (!clientId && !clientSecret) return undefined;
  if (!clientId || !clientSecret) {
    throw new Error("GOOGLE_CLIENT_ID e GOOGLE_CLIENT_SECRET devem ser configurados juntos");
  }
  return { clientId, clientSecret };
}
