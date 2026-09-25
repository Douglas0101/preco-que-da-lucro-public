/**
 * Server-side row caps for tenant listings (plan mestre §16.6 / OWASP API4:
 * unrestricted resource consumption). These are safety nets that bound query
 * and payload size; they are intentionally far above realistic usage so the
 * UI keeps receiving complete lists.
 */
export const LIST_LIMITS = {
  /** Active products returned by read-model listings. */
  products: 500,
  /** Child rows (ingredients, packaging, fees, market prices) per listing. */
  productChildren: 2_000,
  /** Periodic expenses per tenant. */
  expenses: 1_000,
  /** Saved simulations per tenant (rows carry full parameter payloads). */
  simulations: 200,
  /** Latest sales rows surfaced by the venda history listing (plan WS-01). */
  sales: 50,
} as const;

export type ListLimitKey = keyof typeof LIST_LIMITS;
