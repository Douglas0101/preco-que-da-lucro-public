import { describe, expect, it } from "vitest";
import {
  normalizeSqlOperation,
  redactSqlText,
  SQL_REDACTION_MAX_LENGTH,
} from "@/instrumentation/sql-redactor";

describe("sql-redactor (§19.3): redação de texto de query", () => {
  it("substitui literais entre aspas simples por ? (inclusive '' escapado)", () => {
    expect(redactSqlText("select * from users where email = 'a@b.com' and name = 'it''s'")).toBe(
      "select * from users where email = ? and name = ?",
    );
  });

  it("não vaza PII (e-mail, CPF, telefone) contida em literais", () => {
    const redacted = redactSqlText(
      "update users set email = 'joao@example.com', cpf = '123.456.789-00', phone = '+55 11 98888-7777' where id = $1",
    );
    expect(redacted).not.toContain("joao@example.com");
    expect(redacted).not.toContain("123.456.789-00");
    expect(redacted).not.toContain("98888");
    expect(redacted).toContain("$1");
    expect(redacted).toBe("update users set email = ?, cpf = ?, phone = ? where id = $1");
  });

  it("preserva placeholders $1/$2 e identificadores entre aspas duplas", () => {
    expect(redactSqlText('select "tenant name" from t where a = $1 and b = $2')).toBe(
      'select "tenant name" from t where a = $1 and b = $2',
    );
  });

  it("remove comentários de linha e de bloco (aninhados)", () => {
    expect(redactSqlText("select 1 -- password='x'\nfrom t /* secret 'abc' */ where id = 1")).toBe(
      "select 1 from t where id = 1",
    );
    expect(redactSqlText("select 1 /* a /* b */ c */ from t")).toBe("select 1 from t");
  });

  it("aplica escape por barra invertida apenas em E'...'/e'...'", () => {
    // `standard_conforming_strings=on` (default do PostgreSQL): em literal comum a
    // barra invertida é um caractere literal e a aspa é fechada normalmente.
    expect(redactSqlText("select E'a\\'b'")).toBe("select E?");
    expect(redactSqlText("select e'a\\'b'")).toBe("select e?");

    const leaked = redactSqlText("select 'a\\', 'secret' from t");
    expect(leaked).not.toContain("secret");
    expect(leaked).toBe("select ?, ? from t");

    const apostrophe = redactSqlText("select * from t where name = 'O\\'Brien'");
    expect(apostrophe).not.toContain("'Brien'");
    expect(apostrophe).toBe("select * from t where name = ?Brien?");
  });

  it("preserva o conteúdo dos identificadores entre aspas duplas (espaços internos)", () => {
    expect(redactSqlText('select "col  name", "outro\tcol" from "t 1"')).toBe(
      'select "col  name", "outro\tcol" from "t 1"',
    );
  });

  it("encerra comentário de linha também no CR solitário", () => {
    expect(redactSqlText("select 1 -- secret 'x'\rselect 2")).toBe("select 1 select 2");
    expect(redactSqlText("select 1 -- secret 'x'\r\nselect 2")).toBe("select 1 select 2");
  });

  it("substitui dollar-quoted strings", () => {
    expect(redactSqlText("do $body$ select 'x' $body$ language plpgsql")).toBe(
      "do ? language plpgsql",
    );
  });

  it("trunca em SQL_REDACTION_MAX_LENGTH com sufixo ...", () => {
    const redacted = redactSqlText(`select ${"a".repeat(1_000)} from t`);
    expect(redacted.length).toBe(SQL_REDACTION_MAX_LENGTH);
    expect(redacted.endsWith("...")).toBe(true);
    expect(redactSqlText("select 1").length).toBeLessThan(SQL_REDACTION_MAX_LENGTH);
  });

  it("normaliza a operação para o primeiro keyword conhecido", () => {
    expect(normalizeSqlOperation("select * from t")).toBe("SELECT");
    expect(normalizeSqlOperation("  /* c */ insert into t values ($1)")).toBe("INSERT");
    expect(normalizeSqlOperation("explain analyze select 1")).toBe("EXPLAIN");
    expect(normalizeSqlOperation("wat happens here")).toBe("QUERY");
    expect(normalizeSqlOperation(undefined)).toBe("QUERY");
  });

  it("é defensivo com entradas vazias ou sem keyword", () => {
    expect(redactSqlText("")).toBe("");
    expect(normalizeSqlOperation("   ")).toBe("QUERY");
    expect(normalizeSqlOperation("'só literal'")).toBe("QUERY");
  });
});
