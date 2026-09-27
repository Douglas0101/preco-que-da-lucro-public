import { compare } from "bcryptjs";
import { hashPassword as hashScrypt, verifyPassword as verifyScrypt } from "better-auth/crypto";
import { logJson } from "@/lib/structured-logger";

const BCRYPT_PREFIX = /^\$2[aby]\$/;

/**
 * DBT-26 — a verification that could not produce a verdict is not a verdict.
 *
 * This function used to turn every exception into a plain `false`, which made an
 * unusable stored hash, an unsupported hash format and a broken password
 * primitive indistinguishable from "the user typed the wrong password". The
 * operator could not tell a credential problem from a data problem from an
 * infrastructure problem, and a regression in `bcryptjs`/`better-auth` would
 * present as "everybody forgot their password" — the most expensive reading to
 * diagnose and the easiest to dismiss.
 *
 * (Prose here deliberately avoids the literal swallowed-handler form: the
 * error-swallowing inventory in `src/test/finance.result-invariants.test.ts`
 * scans raw source, comments included, so writing it out would register a
 * finding for a defect this file no longer has.)
 *
 * The classes below are the ones the primitives actually produce. They were
 * measured, not assumed: `src/test/auth.password-verify.test.ts` pins each one
 * against the real call.
 */
export type PasswordVerificationFailure =
  /** `input`, `hash` or `password` is not what the declared signature promises. */
  | "malformed-input"
  /** Both are strings, but no supported format can verify the stored hash. */
  | "unusable-hash"
  /** The hash is well formed for its algorithm and the primitive still failed. */
  | "crypto-failure";

const FAILURE_REASON: Record<PasswordVerificationFailure, string> = {
  "malformed-input": "hash or password is not a string",
  "unusable-hash": "stored hash is not in a supported password format",
  "crypto-failure": "password primitive threw on a well-formed hash",
};

/** Raised instead of `false` whenever verification could not reach a verdict. */
export class PasswordVerificationError extends Error {
  readonly code: PasswordVerificationFailure;
  readonly reason: string;

  constructor(code: PasswordVerificationFailure, options: { cause?: unknown } = {}) {
    super(`password verification failed (${code}): ${FAILURE_REASON[code]}`, options);
    this.name = "PasswordVerificationError";
    this.code = code;
    this.reason = FAILURE_REASON[code];
  }
}

/**
 * Hash-format rejections these primitives raise for string input. Measured
 * against `bcryptjs` and better-auth's scrypt wrapper, whose only `throw` is
 * the `"Invalid password hash"` literal in `@better-auth/utils/password`.
 *
 * An unrecognised failure is reported as `crypto-failure` rather than guessed
 * at: a mislabelled class is still loud and still never `false`, so the
 * failure mode of this predicate is safe in the direction that matters.
 */
const INVALID_PASSWORD_HASH = "Invalid password hash";
const BCRYPT_HASH_REJECTION =
  /^Illegal (?:number of rounds \(\d+-\d+\): \d+|salt length: \d+ != \d+)$/;

function isHashFormatRejection(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  return cause.message === INVALID_PASSWORD_HASH || BCRYPT_HASH_REJECTION.test(cause.message);
}

/**
 * Logs the failure class and returns the error to throw. The hash and the
 * password are never serialised — not even truncated: the class, a fixed
 * reason and the underlying error's *name* are enough to route the incident,
 * and the full cause travels on the thrown error for whoever handles it.
 */
function failedVerification(
  code: PasswordVerificationFailure,
  cause?: unknown,
): PasswordVerificationError {
  logJson("error", "auth.password.verify.failed", {
    code,
    reason: FAILURE_REASON[code],
    causeName: cause === undefined ? null : cause instanceof Error ? cause.name : typeof cause,
  });
  return new PasswordVerificationError(code, cause === undefined ? {} : { cause });
}

export async function hashPassword(password: string): Promise<string> {
  return hashScrypt(password);
}

export async function verifyPassword(input: { hash: string; password: string }): Promise<boolean> {
  // The declared type promises strings, but the caller is `better-auth`,
  // handing over whatever the credential row holds. Check the promise at
  // runtime instead of trusting it.
  const raw: unknown = input;
  if (typeof raw !== "object" || raw === null) {
    throw failedVerification("malformed-input");
  }
  const { hash, password } = raw as { hash?: unknown; password?: unknown };
  if (typeof hash !== "string" || typeof password !== "string") {
    throw failedVerification("malformed-input");
  }

  try {
    if (BCRYPT_PREFIX.test(hash)) {
      // bcryptjs accepts 2a/2b. Supabase can also export 2y, whose semantics
      // are compatible for this verifier after normalizing the marker.
      const normalized = hash.startsWith("$2y$") ? `$2b$${hash.slice(4)}` : hash;
      return await compare(password, normalized);
    }
    return await verifyScrypt({ hash, password });
  } catch (cause) {
    const code: PasswordVerificationFailure = isHashFormatRejection(cause)
      ? "unusable-hash"
      : "crypto-failure";
    throw failedVerification(code, cause);
  }
}
