import type { Metric } from "web-vitals";

const VITALS_ENDPOINT = "/api/vitals";

function reportVital(metric: Metric): void {
  const body = JSON.stringify({
    id: metric.id,
    name: metric.name,
    value: metric.value,
    rating: metric.rating,
    delta: metric.delta,
    ...(metric.navigationType ? { navigationType: metric.navigationType } : {}),
  });
  if (
    typeof navigator.sendBeacon === "function" &&
    navigator.sendBeacon(VITALS_ENDPOINT, new Blob([body], { type: "application/json" }))
  ) {
    return;
  }
  void fetch(VITALS_ENDPOINT, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    keepalive: true,
  }).catch(() => undefined);
}

let initialized = false;

export function initWebVitals(): void {
  if (initialized || typeof window === "undefined") return;
  initialized = true;
  void import("web-vitals")
    .then(({ onCLS, onFCP, onINP, onLCP, onTTFB }) => {
      for (const register of [onCLS, onFCP, onINP, onLCP, onTTFB]) {
        register(reportVital);
      }
    })
    .catch(() => undefined);
}
