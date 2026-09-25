// Differentiated rate-limit buckets for sensitive auth endpoints (plan §20.5).
// Keys are matched by exact path unless they contain "*" (Better Auth wildcard).
export const AUTH_RATE_LIMIT_RULES = {
  // Login brute-force protection: 5 attempts per minute per IP.
  "/sign-in/email": { window: 60, max: 5 },
  // Sign-up throttling: 3 accounts per minute per IP.
  "/sign-up/email": { window: 60, max: 3 },
  // Password reset request: 3 emails per 15 minutes per IP (spam/enumeration guard).
  "/forget-password*": { window: 900, max: 3 },
  // Reset confirmation is not covered by any default special rule; keep it tight too.
  "/reset-password": { window: 300, max: 10 },
} as const;

export type AuthRateLimitRules = typeof AUTH_RATE_LIMIT_RULES;

// Buckets keyed by the acting user and consumed by our own code (not by Better
// Auth): the key is `<bucket>|<userId>`, so one user cannot spend another's
// budget and every instance shares the same counter.
export const USER_RATE_LIMIT_RULES = {
  // Chat turns per user per 10 minutes. The effective max stays configurable
  // through AI_CHAT_LIMIT_PER_10_MINUTES (default: this value); ADR-021 item 7.
  chat: { window: 600, max: 20 },
  // Tool executions per user per 10 minutes. One turn may run several tools
  // (up to AI_MAX_TOOL_ROUNDS rounds), so the bucket is wider than the chat one.
  tool: { window: 600, max: 40 },
} as const;

export type UserRateLimitBucket = keyof typeof USER_RATE_LIMIT_RULES;

export function userRateLimitKey(bucket: UserRateLimitBucket, userId: string): string {
  return `${bucket}|${userId}`;
}
