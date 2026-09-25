import { createStart, createCsrfMiddleware, createMiddleware } from "@tanstack/react-start";

import { renderErrorPage } from "./lib/error-page";
import { applicationMetrics, ensureTelemetryStarted } from "./instrumentation/telemetry";
import { recordSafely } from "./instrumentation/safe-record";
import { setHttpResponseStatus, withHttpRequestSpan } from "./instrumentation/http-request-span";
import { apiErrorResponse, errorCodeFromUnknown } from "./lib/api-error";
import { logJson } from "./lib/structured-logger";
import { securityHeaders } from "./lib/security-headers";

const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function applyRequestHeaders(
  response: Response,
  correlationId: string,
  handlerType: string,
): Response {
  response.headers.set("x-correlation-id", correlationId);
  for (const [name, value] of Object.entries(securityHeaders())) {
    response.headers.set(name, value);
  }
  if (handlerType === "serverFn") {
    response.headers.set("cache-control", "private, no-store");
    response.headers.append("vary", "Cookie");
  }
  return response;
}

function handleResponseError(
  error: Response,
  correlationId: string,
  handlerType: string,
  startedAt: number,
  request: Request,
): never {
  applyRequestHeaders(error, correlationId, handlerType);
  recordSafely(applicationMetrics.requestDuration, performance.now() - startedAt, {
    method: request.method,
    status: error.status,
  });
  throw error;
}

function handleUnexpectedError(
  error: unknown,
  correlationId: string,
  handlerType: string,
  startedAt: number,
  request: Request,
): Response {
  const code = errorCodeFromUnknown(error);
  applicationMetrics.errors.add(1, { code });
  logJson("error", "request.failed", {
    correlationId,
    code,
    method: request.method,
    pathname: new URL(request.url).pathname,
    durationMs: Math.round(performance.now() - startedAt),
    error,
  });
  const response =
    handlerType === "serverFn"
      ? apiErrorResponse(code, correlationId)
      : new Response(renderErrorPage(), {
          status: 500,
          headers: {
            "content-type": "text/html; charset=utf-8",
          },
        });
  applyRequestHeaders(response, correlationId, handlerType);
  recordSafely(applicationMetrics.requestDuration, performance.now() - startedAt, {
    method: request.method,
    status: response.status,
  });
  return response;
}

const requestPolicyMiddleware = createMiddleware().server(
  async ({ handlerType, next, request }) => {
    ensureTelemetryStarted();
    const suppliedCorrelationId = request.headers.get("x-correlation-id");
    const correlationId =
      suppliedCorrelationId && uuidPattern.test(suppliedCorrelationId)
        ? suppliedCorrelationId
        : crypto.randomUUID();
    const startedAt = performance.now();
    const pathname = new URL(request.url).pathname;

    return withHttpRequestSpan(
      {
        "http.request.method": request.method,
        "url.path": pathname,
        "app.correlation_id": correlationId,
      },
      async (span) => {
        try {
          const result = await next({ context: { correlationId } });
          const response = applyRequestHeaders(
            new Response(result.response.body, result.response),
            correlationId,
            handlerType,
          );
          setHttpResponseStatus(span, response.status);
          logJson("info", "request.completed", {
            correlationId,
            method: request.method,
            pathname,
            status: response.status,
            durationMs: Math.round(performance.now() - startedAt),
          });
          recordSafely(applicationMetrics.requestDuration, performance.now() - startedAt, {
            method: request.method,
            status: response.status,
          });
          return { ...result, response };
        } catch (error) {
          if (error instanceof Response) {
            setHttpResponseStatus(span, error.status);
            return handleResponseError(error, correlationId, handlerType, startedAt, request);
          }
          const response = handleUnexpectedError(
            error,
            correlationId,
            handlerType,
            startedAt,
            request,
          );
          setHttpResponseStatus(span, response.status);
          if (error instanceof Error) span.recordException(error);
          return response;
        }
      },
    );
  },
);

// Start installs this automatically when src/start.ts is absent; defining the
// file opts out, so re-add it explicitly to keep server functions protected
// from cross-site requests.
const csrfMiddleware = createCsrfMiddleware({
  filter: (ctx) => ctx.handlerType === "serverFn",
});

export const startInstance = createStart(() => ({
  functionMiddleware: [],
  requestMiddleware: [requestPolicyMiddleware, csrfMiddleware],
}));
