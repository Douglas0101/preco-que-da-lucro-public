import { z } from "zod";

export const WEB_VITALS_MAX_PAYLOAD_BYTES = 2_048;

export const vitalMetricSchema = z.object({
  id: z.string().min(1).max(64),
  name: z.enum(["CLS", "FCP", "INP", "LCP", "TTFB"]),
  value: z.number().finite().min(0),
  rating: z.enum(["good", "needs-improvement", "poor"]),
  delta: z.number().finite().min(0),
  navigationType: z
    .enum(["navigate", "reload", "back-forward", "back-forward-cache", "prerender", "restore"])
    .optional(),
  entries: z.array(z.unknown()).max(10).optional(),
});

export type VitalMetricPayload = z.output<typeof vitalMetricSchema>;

export function safeParseVitalMetric(payload: unknown): VitalMetricPayload | null {
  const result = vitalMetricSchema.safeParse(payload);
  return result.success ? result.data : null;
}
