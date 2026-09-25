import { compare } from "bcryptjs";
import { hashPassword as hashScrypt, verifyPassword as verifyScrypt } from "better-auth/crypto";

const BCRYPT_PREFIX = /^\$2[aby]\$/;

export async function hashPassword(password: string): Promise<string> {
  return hashScrypt(password);
}

export async function verifyPassword(input: { hash: string; password: string }): Promise<boolean> {
  try {
    if (BCRYPT_PREFIX.test(input.hash)) {
      // bcryptjs accepts 2a/2b. Supabase can also export 2y, whose semantics
      // are compatible for this verifier after normalizing the marker.
      const normalized = input.hash.startsWith("$2y$") ? `$2b$${input.hash.slice(4)}` : input.hash;
      return await compare(input.password, normalized);
    }
    return await verifyScrypt(input);
  } catch {
    return false;
  }
}
