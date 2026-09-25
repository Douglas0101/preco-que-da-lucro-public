import { describe, expect, it, vi } from "vitest";
import {
  apiError,
  apiErrorResponse,
  ApplicationError,
  errorCodeFromUnknown,
} from "@/lib/api-error";
import { logJson, redactLogValue } from "@/lib/structured-logger";
import { describeError } from "@/lib/error-capture";

const correlationId = "50000000-0000-4000-8000-000000000005";

describe("taxonomia pública de erros", () => {
  it("não expõe a causa interna e mantém retry explícito", async () => {
    const internal = new ApplicationError("DATABASE_ERROR", {
      cause: new Error("password=segredo postgresql://127.0.0.1:5432/preco_test"),
    });
    const response = apiErrorResponse(errorCodeFromUnknown(internal), correlationId);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(response.headers.get("x-correlation-id")).toBe(correlationId);
    expect(body).toEqual({
      ok: false,
      error: apiError("DATABASE_ERROR", correlationId),
    });
    expect(JSON.stringify(body)).not.toContain("segredo");
    expect(errorCodeFromUnknown(new Error("INVALID_PRICE_UNIT"))).toBe("VALIDATION_ERROR");
  });
});

describe("logs estruturados com redaction", () => {
  it("remove credenciais, PII e URLs de banco inclusive em objetos aninhados", () => {
    const redacted = redactLogValue({
      cookie: "session=abc",
      nested: {
        email: "maria@example.com",
        note: "fale com maria@example.com usando Bearer abc.def",
        url: "postgresql://127.0.0.1:5432/preco_test",
      },
    });
    const encoded = JSON.stringify(redacted);

    expect(encoded).not.toContain("session=abc");
    expect(encoded).not.toContain("maria@example.com");
    expect(encoded).not.toContain("abc.def");
    expect(encoded).not.toContain("admin:password");
  });

  it("emite uma linha JSON por evento", () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => undefined);
    logJson("info", "request.completed", { correlationId });
    expect(() => JSON.parse(String(info.mock.calls[0]?.[0]))).not.toThrow();
    info.mockRestore();
  });

  it("redige causa e stack no caminho catastrófico", () => {
    const error = new Error("postgresql://127.0.0.1:5432/preco_test password=segredo");
    const described = describeError(error);
    expect(described).not.toContain("secret@db.example");
    expect(described).not.toContain("password=segredo");
  });
});
