import "./lib/error-capture";

import { consumeLastCapturedError } from "./lib/error-capture";
import { renderErrorPage } from "./lib/error-page";
import { assertPricingConfigForBoot } from "./lib/ai/budget-ledger.server";
import { logJson } from "./lib/structured-logger";
import { securityHeaders } from "./lib/security-headers";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// Fail-fast de boot (API-001 §6.9 / §14.6): AI_MODEL_PRICING_JSON definida e
// inválida derruba o boot com um CONFIG_ERROR explícito; variável ausente usa
// os preços padrão documentados, então o dev não precisa de configuração.
assertPricingConfigForBoot();

type ServerEntry = {
  fetch: (request: Request, env: unknown, ctx: unknown) => Promise<Response> | Response;
};

let serverEntryPromise: Promise<ServerEntry> | undefined;

async function getServerEntry(): Promise<ServerEntry> {
  if (!serverEntryPromise) {
    serverEntryPromise = import("@tanstack/react-start/server-entry").then(
      (m) => (m.default ?? m) as ServerEntry,
    );
  }
  return serverEntryPromise;
}

// h3 swallows in-handler throws into a normal 500 Response with body
// {"unhandled":true,"message":"HTTPError"} — try/catch alone never fires for those.
function responseWithServerPolicy(response: Response, correlationId: string): Response {
  response.headers.set("x-correlation-id", correlationId);
  for (const [name, value] of Object.entries(securityHeaders())) {
    response.headers.set(name, value);
  }
  if (response.status >= 500) response.headers.set("cache-control", "no-store");
  return response;
}

function renderCatastrophicResponse(correlationId: string): Response {
  return new Response(renderErrorPage(), {
    status: 500,
    headers: {
      "cache-control": "no-store",
      "content-type": "text/html; charset=utf-8",
      "x-correlation-id": correlationId,
      ...securityHeaders(),
    },
  });
}

async function normalizeCatastrophicSsrResponse(
  response: Response,
  correlationId: string,
): Promise<Response> {
  if (response.status < 500) return response;
  const contentType = response.headers.get("content-type") ?? "";
  if (!contentType.includes("application/json")) return response;

  const body = await response.clone().text();
  if (!isH3SwallowedErrorBody(body)) return response;

  logJson("error", "server.ssr_failed", {
    correlationId,
    error: consumeLastCapturedError() ?? new Error(`h3 swallowed SSR error: ${body}`),
  });
  return renderCatastrophicResponse(correlationId);
}

function isH3SwallowedErrorBody(body: string): boolean {
  try {
    const payload = JSON.parse(body) as { unhandled?: unknown; message?: unknown };
    return payload.unhandled === true && payload.message === "HTTPError";
  } catch {
    return false;
  }
}

export default {
  async fetch(request: Request, env: unknown, ctx: unknown) {
    const suppliedCorrelationId = request.headers.get("x-correlation-id");
    const correlationId =
      suppliedCorrelationId && uuidPattern.test(suppliedCorrelationId)
        ? suppliedCorrelationId
        : crypto.randomUUID();
    try {
      const handler = await getServerEntry();
      const response = await handler.fetch(request, env, ctx);
      return responseWithServerPolicy(
        await normalizeCatastrophicSsrResponse(response, correlationId),
        correlationId,
      );
    } catch (error) {
      logJson("error", "server.entry_failed", {
        correlationId,
        error,
      });
      return renderCatastrophicResponse(correlationId);
    }
  },
};
