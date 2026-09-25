import { describe, expect, it } from "vitest";
import {
  DB_ENV_KEYS,
  DB_OPTIONAL_KEYS,
  DB_REQUIRED_KEYS,
  dbPrecondition,
  isLoopbackUrl,
  skipLabel,
} from "./helpers/db-precondition";

const LOOPBACK = "postgres://u:p@127.0.0.1:5432/db";
const REMOTO = (() => {
  const url = new URL(`${"postgresql"}://placeholder.example`);
  url.username = "fixture-user";
  url.password = "fixture-password";
  url.hostname = "remote-placeholder.example";
  url.port = "5432";
  url.pathname = "/preco_test";
  return url.href;
})();

function env(parcial: Partial<Record<(typeof DB_ENV_KEYS)[number], string>>): NodeJS.ProcessEnv {
  return { ...parcial } as NodeJS.ProcessEnv;
}

describe("precondição de banco — tudo ou nada, falha alta (WP-R6)", () => {
  it("sem nenhuma URL: desabilitado, com motivo nomeado", () => {
    const gate = dbPrecondition(env({}));
    expect(gate.enabled).toBe(false);
    expect(gate.enabled === false && gate.motivo).toContain("N/A-sem-DB");
    expect(skipLabel("x")).toBe("db-precondition: x");
  });

  it("as três URLs em loopback: habilitado", () => {
    const gate = dbPrecondition({
      DATABASE_ADMIN_URL: LOOPBACK,
      DATABASE_URL: LOOPBACK,
      DATABASE_URL_UNPOOLED: LOOPBACK,
    });
    expect(gate.enabled).toBe(true);
  });

  it("o setup DOCUMENTADO do `db:test` (par obrigatório, sem UNPOOLED) roda", () => {
    // `AGENTS.md`: "`npm run db:test` is self-contained ... with DATABASE_URL/DATABASE_ADMIN_URL
    // pointing at 127.0.0.1:5432". Exigir a terceira URL quebrava esse comando de contrato —
    // regressão medida e corrigida antes do selo.
    const gate = dbPrecondition({ DATABASE_ADMIN_URL: LOOPBACK, DATABASE_URL: LOOPBACK });
    expect(gate.enabled).toBe(true);
  });

  it("UNPOOLED é opcional, mas definida e remota é kill-switch (reprova)", () => {
    expect(() =>
      dbPrecondition({
        DATABASE_ADMIN_URL: LOOPBACK,
        DATABASE_URL: LOOPBACK,
        DATABASE_URL_UNPOOLED: REMOTO,
      }),
    ).toThrow(/DATABASE_URL_UNPOOLED nao aponta para loopback/);
  });

  it("só UNPOOLED definida reprova em vez de pular", () => {
    expect(() => dbPrecondition({ DATABASE_URL_UNPOOLED: REMOTO })).toThrow(
      /DATABASE_ADMIN_URL ausente/,
    );
  });

  it("uma URL remota reprova em vez de pular em silêncio (o fail-open do WP-R6)", () => {
    expect(() =>
      dbPrecondition({
        DATABASE_ADMIN_URL: LOOPBACK,
        DATABASE_URL: REMOTO,
        DATABASE_URL_UNPOOLED: LOOPBACK,
      }),
    ).toThrow(/nao aponta para loopback/);
  });

  it("configuração parcial reprova nomeando a chave ausente", () => {
    expect(() => dbPrecondition({ DATABASE_ADMIN_URL: LOOPBACK })).toThrow(/DATABASE_URL ausente/);
    expect(() => dbPrecondition({ DATABASE_URL: REMOTO })).toThrow(/DATABASE_ADMIN_URL ausente/);
  });

  it("o motivo nomeia as chaves declaradas e o problema, não só um booleano", () => {
    try {
      dbPrecondition({ DATABASE_URL: REMOTO });
      throw new Error("deveria ter lançado");
    } catch (error) {
      const mensagem = (error as Error).message;
      expect(mensagem).toContain("DATABASE_URL");
      expect(mensagem).toContain("nao aponta para loopback");
      expect(mensagem).toContain("ou nenhuma");
    }
  });

  it("isLoopbackUrl distingue ausente de loopback (o booleano invertido do defeito)", () => {
    // A versão anterior devolvia `true` para `undefined`, o que fazia a expressão
    // `Boolean(admin) && isLoopback(admin) && isLoopback(undefined) && ...` valer `true`
    // com duas URLs ausentes.
    expect(isLoopbackUrl(undefined)).toBe(false);
    expect(isLoopbackUrl("")).toBe(false);
    expect(isLoopbackUrl(LOOPBACK)).toBe(true);
    expect(isLoopbackUrl("postgres://u:p@localhost:5432/db")).toBe(true);
    expect(isLoopbackUrl("postgres://u:p@[::1]:5432/db")).toBe(true);
    expect(isLoopbackUrl(REMOTO)).toBe(false);
    expect(isLoopbackUrl("nao-e-url")).toBe(false);
  });

  it("aceita as grafias de loopback que o libpq aceita (S6 N8)", () => {
    // O hostname do WHATWG preserva a caixa, mantém `127.1` sem expandir, deixa o ponto
    // final e converte IPv4-mapeado para hex — recusá-las virava erro duro onde antes o
    // bloco pulava, impedindo rodar a suíte com um banco local válido.
    expect(isLoopbackUrl("postgresql://u@127.0.0.1:5432/x")).toBe(true);
    expect(isLoopbackUrl("postgresql://u@127.1:5432/x")).toBe(true);
    expect(isLoopbackUrl("postgresql://u@127.0.0.2:5432/x")).toBe(true);
    expect(isLoopbackUrl("postgresql://u@LOCALHOST:5432/x")).toBe(true);
    expect(isLoopbackUrl("postgresql://u@localhost.:5432/x")).toBe(true);
    expect(isLoopbackUrl("postgresql://u@[::1]:5432/x")).toBe(true);
    expect(isLoopbackUrl("postgresql://u@[0:0:0:0:0:0:0:1]:5432/x")).toBe(true);
    expect(isLoopbackUrl("postgresql://u@[::ffff:127.0.0.1]:5432/x")).toBe(true);
    // `0.0.0.0` é bind-wildcard, não loopback: recusado de propósito.
    expect(isLoopbackUrl("postgresql://u@0.0.0.0:5432/x")).toBe(false);
  });

  it("valor definido e VAZIO é configuração inválida, não ausência (S6 N7)", () => {
    // Presença por `!== undefined`, não por `Boolean`: um `.env` com as três vazias
    // reproduzia o estado de skip anterior ao WP.
    expect(() =>
      dbPrecondition({ DATABASE_ADMIN_URL: "", DATABASE_URL: "", DATABASE_URL_UNPOOLED: "" }),
    ).toThrow(/precondicao de banco invalida/);
    expect(() => dbPrecondition({ DATABASE_ADMIN_URL: "", DATABASE_URL: LOOPBACK })).toThrow(
      /DATABASE_ADMIN_URL nao aponta para loopback/,
    );
  });

  it("o par obrigatório e o opcional são explícitos, sem lista implícita", () => {
    expect([...DB_REQUIRED_KEYS]).toEqual(["DATABASE_ADMIN_URL", "DATABASE_URL"]);
    expect([...DB_OPTIONAL_KEYS]).toEqual(["DATABASE_URL_UNPOOLED"]);
    expect([...DB_ENV_KEYS]).toEqual([
      "DATABASE_ADMIN_URL",
      "DATABASE_URL",
      "DATABASE_URL_UNPOOLED",
    ]);
  });
});
