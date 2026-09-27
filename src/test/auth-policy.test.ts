import { hashSync } from "bcryptjs";
import { describe, expect, it, vi } from "vitest";
import {
  requireAuthSecret,
  resolveAuthPolicy,
  resolveGoogleCredentials,
} from "@/server/auth/auth-policy";
import {
  hashPassword,
  PasswordVerificationError,
  verifyPassword,
} from "@/server/auth/password.server";

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

  // CONTRATO ALTERADO (DBT-26), AUTORIZADO.
  //
  // Até DBT-26 esta asserção fixava `hash: "unknown"` → `false`, e ao fazê-lo
  // codificava o defeito: uma exceção de verificador era indistinguível de
  // "o usuário digitou a senha errada". O caso NÃO foi removido nem afrouxado —
  // o veredito mudou de "senha errada" para "não foi possível verificar", que
  // agora LANÇA `PasswordVerificationError` com código `unusable-hash`.
  //
  // Autorização: docs/sdd/SDD-20260925-contract-guard/MAESTRO-REQUEST-DBT-26.md
  // (§6, correção autorizada com taxonomia baseada em evidência).
  //
  // Fail-closed PRESERVADO: nenhum acesso é concedido. O `throw` sobe pelo
  // guarda de sign-in do better-auth, que não o captura — é o ramo NEGADO,
  // nunca o ramo que cria a sessão.
  it("DBT-26: hash desconhecido agora LANÇA (contrato alterado, autorizado) e segue fail-closed", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
    try {
      await expect(verifyPassword({ hash: "unknown", password: "senha" })).rejects.toBeInstanceOf(
        PasswordVerificationError,
      );
      // O sinal estruturado faz parte do contrato novo, não é efeito colateral.
      expect(String(logged.mock.calls[0]?.[0])).toContain("auth.password.verify.failed");
    } finally {
      logged.mockRestore();
    }

    // `false` continua reservado à única coisa que ele significa: senha errada.
    const hash = hashSync("senha-legada-segura", 4);
    await expect(verifyPassword({ hash, password: "outra-senha" })).resolves.toBe(false);
  });
});
