import { createFileRoute } from "@tanstack/react-router";
import { getDatabase } from "@/db/client.server";
import { rumVitals } from "@/db/schema";
import { logJson } from "@/lib/structured-logger";
import {
  WEB_VITALS_MAX_PAYLOAD_BYTES,
  safeParseVitalMetric,
  type VitalMetricPayload,
} from "@/lib/web-vitals-payload";

const NO_STORE = { headers: { "cache-control": "no-store" } };

/** Persistência ligada por padrão; `RUM_PERSISTENCE_ENABLED=false` volta ao log-only. */
function rumPersistenceEnabled(): boolean {
  return process.env.RUM_PERSISTENCE_ENABLED !== "false";
}

/** INSERT best-effort (§17.8): qualquer falha vira warn e nunca muda o status. */
async function persistVital(metric: VitalMetricPayload): Promise<void> {
  if (!rumPersistenceEnabled()) return;
  try {
    await getDatabase()
      .insert(rumVitals)
      .values({
        metricId: metric.id,
        name: metric.name,
        value: metric.value,
        rating: metric.rating,
        delta: metric.delta,
        navigationType: metric.navigationType ?? null,
      });
  } catch (error) {
    logJson("warn", "rum.web_vitals_persist_failed", { name: metric.name, error });
  }
}

function rejected(reason: string): Response {
  logJson("warn", "rum.web_vitals_rejected", { reason });
  return new Response(null, { status: reason === "payload_too_large" ? 413 : 400, ...NO_STORE });
}

export async function handleVitalsPost({ request }: { request: Request }): Promise<Response> {
  const contentLength = Number(request.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > WEB_VITALS_MAX_PAYLOAD_BYTES) {
    return rejected("payload_too_large");
  }

  const raw = await request.text();
  if (new TextEncoder().encode(raw).length > WEB_VITALS_MAX_PAYLOAD_BYTES) {
    return rejected("payload_too_large");
  }

  let payload: unknown;
  try {
    payload = JSON.parse(raw);
  } catch {
    return rejected("invalid_json");
  }

  const metric = safeParseVitalMetric(payload);
  if (!metric) return rejected("invalid_payload");

  logJson("info", "rum.web_vitals", {
    id: metric.id,
    name: metric.name,
    value: metric.value,
    rating: metric.rating,
    delta: metric.delta,
    navigationType: metric.navigationType,
  });
  await persistVital(metric);
  return new Response(null, { status: 204, ...NO_STORE });
}

export const Route = createFileRoute("/api/vitals")({
  server: {
    handlers: {
      POST: handleVitalsPost,
    },
  },
});
