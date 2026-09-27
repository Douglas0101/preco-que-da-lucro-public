import { compare, hashSync } from "bcryptjs";
import { beforeEach, describe, expect, it, vi, type MockInstance } from "vitest";
import {
  hashPassword,
  PasswordVerificationError,
  type PasswordVerificationFailure,
  verifyPassword,
} from "@/server/auth/password.server";

/**
 * Closure test for DBT-26
 * (`docs/sdd/SDD-20260925-contract-guard/MAESTRO-REQUEST-DBT-26.md`).
 *
 * `verifyPassword` is pure crypto: it receives `{ hash, password }` and performs
 * ZERO database access. Every failure class pinned here was MEASURED against
 * `bcryptjs` and `better-auth/crypto` — a closure test naming a `DatabaseError`
 * or a `TimeoutError` would be fiction, because there is no I/O on this path.
 *
 * The defect being closed: `catch { return false }` made an unusable hash, an
 * unsupported format and a broken primitive indistinguishable from "the user
 * typed the wrong password".
 */

// ---------------------------------------------------------------------------
// Injected primitive failure. A hash format this repository does not support is
// rejected by the primitive with a *recognised* message (see the taxonomy
// below), so no real input reaches `crypto-failure`: a genuine runtime failure
// is by definition not reproducible on demand. It is injected here, and the
// delegation below keeps `compare` real for every other test in this file.
// ---------------------------------------------------------------------------
const primitive = vi.hoisted(() => ({ failCompare: false }));

vi.mock("bcryptjs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("bcryptjs")>();
  return {
    ...actual,
    compare: (password: string, hash: string): Promise<boolean> => {
      if (primitive.failCompare) return Promise.reject(new Error("simulated primitive failure"));
      return actual.compare(password, hash);
    },
  };
});

const CORRECT = ["senha", "correta", "e", "longa"].join("-");
const WRONG = ["senha", "errada", "e", "longa"].join("-");

// Distinctive sentinels so "the log never serialised it" is a real assertion
// and not an accident of the redactor: the strings appear nowhere else.
const HASH_SENTINEL = "SENTINEL_HASH_do-not-log_4f2a";
const PASSWORD_SENTINEL = "SENTINEL_PASSWORD_do-not-log_9c17";

// Every failure path under test emits a structured error line. Capture it once
// per test so the suite output stays readable, and assert on it where the
// contract is about the signal itself.
let logged: MockInstance;

beforeEach(() => {
  logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
});

/** Bypasses the declared signature on purpose: these are shapes the type
 *  forbids and that `better-auth` can still hand over from a credential row. */
const asInput = (input: unknown): { hash: string; password: string } =>
  input as { hash: string; password: string };

type Outcome = { kind: "resolved"; value: boolean } | { kind: "threw"; error: unknown };

const outcome = async (input: unknown): Promise<Outcome> => {
  try {
    return { kind: "resolved", value: await verifyPassword(asInput(input)) };
  } catch (error) {
    return { kind: "threw", error };
  }
};

const failureOf = (result: Outcome): PasswordVerificationError => {
  expect(result.kind).toBe("threw");
  const error = (result as { error: unknown }).error;
  expect(error).toBeInstanceOf(PasswordVerificationError);
  return error as PasswordVerificationError;
};

describe("DBT-26 (a) credencial inválida continua sendo um veredito, não uma exceção", () => {
  it("bcrypt: hash válido + senha errada resolve `false`", async () => {
    const hash = hashSync(CORRECT, 4);
    await expect(verifyPassword({ hash, password: CORRECT })).resolves.toBe(true);
    await expect(verifyPassword({ hash, password: WRONG })).resolves.toBe(false);
  });

  it("scrypt: hash válido + senha errada resolve `false`", async () => {
    const hash = await hashPassword(CORRECT);
    await expect(verifyPassword({ hash, password: CORRECT })).resolves.toBe(true);
    await expect(verifyPassword({ hash, password: WRONG })).resolves.toBe(false);
  });

  it("`false` continua sendo a ÚNICA coisa que uma senha errada produz", async () => {
    // Não-vacuidade: a mesma entrada, com o hash correto, resolve `true`.
    const hash = hashSync(CORRECT, 4);
    const mismatch = await outcome({ hash, password: WRONG });
    const match = await outcome({ hash, password: CORRECT });
    expect(mismatch).toEqual({ kind: "resolved", value: false });
    expect(match).toEqual({ kind: "resolved", value: true });
    expect(logged).not.toHaveBeenCalled();
  });
});

describe("DBT-26 (b) hash inutilizável produz erro de verificador DISTINTO", () => {
  it("nunca o mesmo resultado de (a)", async () => {
    const invalidCredential = await outcome({ hash: hashSync(CORRECT, 4), password: WRONG });
    const corruptHash = await outcome({ hash: "unknown", password: WRONG });

    // (a) é um veredito; (b) é a ausência de veredito. É esta desigualdade que
    // o `catch { return false }` apagava.
    expect(invalidCredential).toEqual({ kind: "resolved", value: false });
    expect(corruptHash).not.toEqual(invalidCredential);
    expect(failureOf(corruptHash).code).toBe("unusable-hash");
  });

  // Each entry is a real call, measured — not a guess about what the
  // primitives do. `why` records the mechanism so a failure is diagnosable
  // from the test name alone.
  const CORRUPT_HASHES: { hash: string; why: string }[] = [
    { hash: "unknown", why: "sem par `salt:key`: a rejeição do scrypt do better-auth" },
    { hash: "", why: "hash vazio" },
    { hash: "deadbeef:", why: "chave ausente depois do separador" },
    { hash: ":cafebabe", why: "salt ausente antes do separador" },
    { hash: "$2c$04$abc", why: "variante bcrypt não suportada; cai no caminho scrypt" },
    { hash: "$2a$99$" + "x".repeat(53), why: "custo bcrypt fora de 4..31" },
    { hash: "$2a$04$" + "!".repeat(22) + "x".repeat(31), why: "salt bcrypt indecodificável" },
  ];

  it.each(CORRUPT_HASHES)("hash corrompido ($why) → `unusable-hash`", async ({ hash }) => {
    expect(failureOf(await outcome({ hash, password: WRONG })).code).toBe("unusable-hash");
  });

  const MALFORMED_INPUTS: { input: unknown; why: string }[] = [
    { input: { hash: null, password: WRONG }, why: "hash nulo vindo da credencial" },
    { input: { hash: 42, password: WRONG }, why: "hash não-string" },
    { input: { hash: "abc:def", password: 123 }, why: "senha não-string" },
    { input: undefined, why: "chamada posicional — o wrapper exige { hash, password }" },
  ];

  it.each(MALFORMED_INPUTS)("entrada malformada ($why) → `malformed-input`", async ({ input }) => {
    expect(failureOf(await outcome(input)).code).toBe("malformed-input");
  });

  it("falha de runtime do primitivo → `crypto-failure`, nunca `false`", async () => {
    primitive.failCompare = true;
    try {
      const hash = hashSync(CORRECT, 4);
      const error = failureOf(await outcome({ hash, password: CORRECT }));
      expect(error.code).toBe("crypto-failure");
      // A causa viaja no erro para quem trata a propagação; ela não é adivinhada.
      expect(error.cause).toBeInstanceOf(Error);
      expect(logged).toHaveBeenCalledTimes(1);
    } finally {
      primitive.failCompare = false;
    }
  });

  it("o caminho de hash válido NÃO é classificado como falha", async () => {
    // Fronteira nas duas direções: o classificador não pode capturar o caso bom.
    const hash = hashSync(CORRECT, 4);
    expect(await outcome({ hash, password: WRONG })).toEqual({ kind: "resolved", value: false });
    expect(await hashPassword(CORRECT)).toMatch(/^[0-9a-f]+:[0-9a-f]+$/);
  });
});

describe("DBT-26 (c) o caminho de erro registra o motivo e não vaza segredo", () => {
  it("emite sinal nível error com o motivo, sem serializar hash nem senha", async () => {
    const error = failureOf(await outcome({ hash: HASH_SENTINEL, password: PASSWORD_SENTINEL }));
    expect(error.code).toBe("unusable-hash");

    expect(logged).toHaveBeenCalledTimes(1);
    const record = String(logged.mock.calls[0]?.[0]);
    const parsed = JSON.parse(record) as {
      level?: string;
      event?: string;
      code?: string;
      reason?: string;
    };

    // Direção 1 — o sinal existe e nomeia o motivo.
    expect(parsed.level).toBe("error");
    expect(parsed.event).toBe("auth.password.verify.failed");
    expect(parsed.code).toBe("unusable-hash");
    expect(parsed.reason).toBe("stored hash is not in a supported password format");

    // Direção 2 — e não carrega o valor do hash nem a senha.
    expect(record).not.toContain(HASH_SENTINEL);
    expect(record).not.toContain(PASSWORD_SENTINEL);

    // A mensagem do erro propaga para fora do endpoint: também não vaza.
    expect(error.message).not.toContain(HASH_SENTINEL);
    expect(error.message).not.toContain(PASSWORD_SENTINEL);
    expect(error.message).toContain("unusable-hash");
  });

  it("as três classes são mutuamente distintas, e nenhuma delas é um veredito", async () => {
    const codes = new Set<PasswordVerificationFailure>();
    codes.add(failureOf(await outcome({ hash: "unknown", password: WRONG })).code);
    codes.add(failureOf(await outcome({ hash: null, password: WRONG })).code);
    primitive.failCompare = true;
    try {
      codes.add(failureOf(await outcome({ hash: hashSync(CORRECT, 4), password: CORRECT })).code);
    } finally {
      primitive.failCompare = false;
    }
    expect([...codes].sort()).toEqual(["crypto-failure", "malformed-input", "unusable-hash"]);
    expect(logged).toHaveBeenCalledTimes(3);
  });
});

describe("DBT-26 (d) CONTROLE NEGATIVO — a reversão para `catch { return false }` reprova", () => {
  it("`false` não é alcançável a partir de um hash inutilizável", async () => {
    // Este é o invariante que a mutação quebra. Não afirma "existe um
    // try/catch": afirma o resultado observável. Com o código mutado de volta
    // para `catch { return false }`, cada `verifyPassword` abaixo RESOLVE
    // `false`, o filtro deixa de ser vazio e a asserção falha — o teste
    // detecta a reversão pelo comportamento, não pela forma do código.
    const unusable = [
      "unknown",
      "",
      "deadbeef:",
      "$2c$04$abc",
      "$2a$99$" + "x".repeat(53),
      "$2a$04$" + "!".repeat(22) + "x".repeat(31),
    ];
    const resolved = [];
    for (const hash of unusable) {
      const result = await outcome({ hash, password: WRONG });
      if (result.kind === "resolved") resolved.push({ hash, value: result.value });
    }
    expect(resolved).toEqual([]);
    expect(logged).toHaveBeenCalledTimes(unusable.length);
  });
});

describe("DBT-26 fail-closed: nenhum acesso é concedido", () => {
  // Espelha o fluxo de `node_modules/better-auth/dist/api/routes/sign-in.mjs`:
  //   if (!await ctx.context.password.verify({ hash: currentPassword, password })) {
  //     throw APIError.from("UNAUTHORIZED", BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD);
  //   }
  // O `verify` não está dentro de try/catch: um `throw` escapa do `if` inteiro
  // e nunca cai no ramo que cria a sessão. Este espelho é de fluxo de controle,
  // não um teste do endpoint vivo (que exigiria o banco).
  const signInGuard = async (input: unknown): Promise<"granted" | "denied" | "threw"> => {
    try {
      return (await verifyPassword(asInput(input))) ? "granted" : "denied";
    } catch {
      return "threw";
    }
  };

  it("senha correta concede, senha errada nega e hash inutilizável sobe", async () => {
    const hash = hashSync(CORRECT, 4);
    await expect(signInGuard({ hash, password: CORRECT })).resolves.toBe("granted");
    await expect(signInGuard({ hash, password: WRONG })).resolves.toBe("denied");
    await expect(signInGuard({ hash: "unknown", password: WRONG })).resolves.toBe("threw");
    await expect(signInGuard({ hash: null, password: WRONG })).resolves.toBe("threw");
  });

  it("nenhum caminho de falha devolve `true`", async () => {
    const failures: unknown[] = [
      { hash: "unknown", password: WRONG },
      { hash: "", password: WRONG },
      { hash: null, password: WRONG },
      { hash: 42, password: WRONG },
      { hash: "abc:def", password: 123 },
      undefined,
    ];
    for (const input of failures) {
      const result = await outcome(input);
      expect(result).not.toEqual({ kind: "resolved", value: true });
      expect(failureOf(result).code).toMatch(/^(?:unusable-hash|malformed-input)$/);
    }
  });
});

describe("DBT-26 o caminho feliz não regrediu", () => {
  it("bcrypt 2a/2b/2y e scrypt continuam verificando", async () => {
    const password = CORRECT;
    const scrypt = await hashPassword(password);
    const bcrypt2a = hashSync(password, 4);
    const bcrypt2b = `$2b$${bcrypt2a.slice(4)}`;
    const bcrypt2y = `$2y$${bcrypt2a.slice(4)}`;

    for (const hash of [scrypt, bcrypt2a, bcrypt2b, bcrypt2y]) {
      await expect(verifyPassword({ hash, password })).resolves.toBe(true);
      await expect(verifyPassword({ hash, password: WRONG })).resolves.toBe(false);
    }
    // `compare` real continua em uso: a delegação do mock não sequestrou nada.
    await expect(compare(password, bcrypt2a)).resolves.toBe(true);
    expect(logged).not.toHaveBeenCalled();
  });
});
