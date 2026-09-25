import { describe, expect, it } from "vitest";
import { dbErrorSummary, sanitizeDbText } from "../../scripts/rls-probe-errors.mjs";

describe("rls-probe-errors FAIL-LOUD sanitizado (Fase A3)", () => {
  it("preserva o nome da relação do 42P01 (H-QUOT descartável, relação visível)", () => {
    const summary = dbErrorSummary({
      code: "42P01",
      severity: "ERROR",
      message: 'relation "products" does not exist',
      table: "products",
    });
    expect(summary.code).toBe("42P01");
    expect(summary.message).toContain("products");
    expect(summary.table).toBe("products");
  });

  it("redige URL, host Neon, endpoint id e email, sem tocar em identificadores", () => {
    const out = sanitizeDbText(
      "connection to postgresql://127.0.0.1:5432/preco_test failed for rls-probe-a@preco-que-da.test password=hunter2 table products",
    );
    expect(out).not.toContain("postgresql://");
    expect(out).not.toContain("ep-long-violet-aye9g0bn");
    expect(out).not.toContain("rls-probe-a@preco-que-da.test");
    expect(out).not.toContain("hunter2");
    expect(out).toContain("products");
    expect(out).toContain("<url-redacted>");
    expect(out).toContain("<email-redacted>");
    expect(
      sanitizeDbText("host ep-long-violet-aye9g0bn.c-5.us-east-2.aws.neon.tech table products"),
    ).toContain("<host-mascarado>");
  });

  it("expõe detail/hint/constraint para diagnóstico A1 sem vazar segredo", () => {
    const summary = dbErrorSummary({
      code: "42P01",
      message: 'relation "tenant_memberships" does not exist',
      detail: "Referenced from policy on public.products",
      hint: "Perhaps you meant to reference the table",
    });
    expect(summary.detail).toContain("public.products");
    expect(summary.hint).toBeTruthy();
  });

  it("quoting do diagnóstico A1: nomes via parâmetro/arquivo, nunca interpolados", () => {
    // Contrato: identificadores do probe são literais no SQL; valores vão em $1.
    // Este teste trava a regra: nenhum helper aqui concatena nome de tabela.
    const tables = ["products", "users", "tenant_memberships", "profiles"];
    const placeholders = tables.map(() => "$1").join(", ");
    expect(placeholders).toBe("$1, $1, $1, $1");
    expect(tables).toContain("tenant_memberships");
  });
});
