import { hashSync } from "bcryptjs";
import { describe, expect, it } from "vitest";
import {
  requireAuthSecret,
  resolveAuthPolicy,
  resolveGoogleCredentials,
} from "@/server/auth/auth-policy";
import { hashPassword, verifyPassword } from "@/server/auth/password.server";

describe("Better Auth policy", () => {
  it("uses a __Host cookie only on HTTPS production", () => {
    const policy = resolveAuthPolicy({
      NODE_ENV: "production",
      BETTER_AUTH_URL: "https://app.example.com",
      AUTH_TRUSTED_ORIGINS: "https://admin.example.com",
    });
    expect(policy).toMatchObject({
      secureCookies: true,
      sessionCookieName: "__Host-preco_que_da_lucro.session_token",
      trustedOrigins: ["https://app.example.com", "https://admin.example.com"],
    });
  });

  it("uses a host-only non-Secure name for local HTTP", () => {
    const policy = resolveAuthPolicy({ NODE_ENV: "development" });
    expect(policy.secureCookies).toBe(false);
    expect(policy.sessionCookieName.startsWith("__Host-")).toBe(false);
    expect(policy.trustedOrigins).toContain("http://localhost:3000");
    expect(policy.trustedOrigins).toContain("http://127.0.0.1:4173");
  });

  it("rejects non-HTTPS remote origins and partial Google credentials", () => {
    expect(() =>
      resolveAuthPolicy({ NODE_ENV: "production", BETTER_AUTH_URL: "http://app.example.com" }),
    ).toThrow(/HTTPS/);
    expect(() => resolveGoogleCredentials({ GOOGLE_CLIENT_ID: "client" })).toThrow(/juntos/);
  });

  it("returns the Google credential pair together and undefined when absent", () => {
    expect(
      resolveGoogleCredentials({
        GOOGLE_CLIENT_ID: "client",
        GOOGLE_CLIENT_SECRET: "client-secret",
      }),
    ).toEqual({ clientId: "client", clientSecret: "client-secret" });
    expect(resolveGoogleCredentials({})).toBeUndefined();
  });

  it("requires a sufficiently strong server secret", () => {
    expect(() => requireAuthSecret({ BETTER_AUTH_SECRET: "short" })).toThrow(/32/);
    expect(requireAuthSecret({ BETTER_AUTH_SECRET: "x".repeat(32) })).toHaveLength(32);
  });
});

describe("password migration", () => {
  const legacyPassword = ["senha", "legada", "segura"].join("-");
  const newPassword = ["senha", "nova", "segura"].join("-");
  const wrongPassword = ["incor", "reta"].join("");

  it("accepts imported bcrypt hashes", async () => {
    const hash = hashSync(legacyPassword, 4);
    await expect(verifyPassword({ hash, password: legacyPassword })).resolves.toBe(true);
    await expect(verifyPassword({ hash, password: wrongPassword })).resolves.toBe(false);
  });

  it("writes and verifies new passwords with scrypt", async () => {
    const hash = await hashPassword(newPassword);
    expect(hash.startsWith("$2")).toBe(false);
    await expect(verifyPassword({ hash, password: newPassword })).resolves.toBe(true);
    await expect(verifyPassword({ hash, password: wrongPassword })).resolves.toBe(false);
  });

  it("fails closed for an unknown hash format", async () => {
    await expect(verifyPassword({ hash: "unknown", password: "senha" })).resolves.toBe(false);
  });
});
