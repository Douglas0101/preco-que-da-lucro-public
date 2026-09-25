import { createFileRoute } from "@tanstack/react-router";
import {
  CSP_REPORT_MAX_PAYLOAD_BYTES,
  cspReportShape,
  parseCspReport,
  type CspReportRejectionReason,
} from "@/lib/csp-report-payload";
import { logJson } from "@/lib/structured-logger";

const NO_STORE = { headers: { "cache-control": "no-store" } };

/** 415 para mídia não suportada, 413 para excesso, 400 para corpo inválido (padrão de `vitals.ts`). */
const REJECTION_STATUS: Record<CspReportRejectionReason, number> = {
  unsupported_media_type: 415,
  payload_too_large: 413,
  invalid_json: 400,
  invalid_payload: 400,
  unexpected_error: 400,
};

/** Coleta best-effort: report recusado vira warn e nunca 500 para o chamador. */
function rejected(reason: CspReportRejectionReason, error?: unknown): Response {
  logJson("warn", "csp.report_rejected", error === undefined ? { reason } : { reason, error });
  return new Response(null, { status: REJECTION_STATUS[reason], ...NO_STORE });
}

async function ingestCspReport(request: Request): Promise<Response> {
  const shape = cspReportShape(request.headers.get("content-type"));
  if (!shape) return rejected("unsupported_media_type");

  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > CSP_REPORT_MAX_PAYLOAD_BYTES) {
    return rejected("payload_too_large");
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > CSP_REPORT_MAX_PAYLOAD_BYTES) {
    return rejected("payload_too_large");
  }

  const parsed = parseCspReport(shape, raw);
  if (!parsed.ok) return rejected(parsed.reason);

  for (const violation of parsed.violations) {
    logJson("warn", "csp.violation", { shape, ...violation });
  }
  if (parsed.suppressed > 0) {
    logJson("warn", "csp.violation_truncated", { shape, suppressed: parsed.suppressed });
  }
  return new Response(null, { status: 204, ...NO_STORE });
}

export async function handleCspReportPost({ request }: { request: Request }): Promise<Response> {
  try {
    return await ingestCspReport(request);
  } catch (error) {
    return rejected("unexpected_error", error);
  }
}

export const Route = createFileRoute("/api/csp-report")({
  server: {
    handlers: {
      POST: handleCspReportPost,
    },
  },
});
