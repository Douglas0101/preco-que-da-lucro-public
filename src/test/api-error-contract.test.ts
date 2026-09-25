import { z } from "zod";
import { describe, expect, it } from "vitest";
import {
  API_ERROR_CODES,
  ApplicationError,
  apiError,
  apiErrorResponse,
  errorCodeFromUnknown,
  type ApiErrorCode,
} from "@/lib/api-error";

const correlationId = "81000000-0000-4000-8000-000000000008";

const statusCases: Array<[ApiErrorCode, number, boolean]> = [
  ["VALIDATION_ERROR", 400, false],
  ["AUTHENTICATION_ERROR", 401, false],
  ["AUTHORIZATION_ERROR", 403, false],
  ["NOT_FOUND", 404, false],
  ["CONFLICT", 409, false],
  ["RATE_LIMIT", 429, true],
  ["DATABASE_ERROR", 503, true],
  ["DEPENDENCY_ERROR", 503, true],
  ["AI_TIMEOUT", 504, true],
  ["AI_QUOTA", 429, false],
  ["INTERNAL_ERROR", 500, false],
];

describe("contrato público de ApiError", () => {
  it("mantém uma política HTTP explícita para cada código", async () => {
    expect(API_ERROR_CODES).toHaveLength(statusCases.length);

    for (const [code, status, retryable] of statusCases) {
      const response = apiErrorResponse(code, correlationId);
      const body = await response.json();

      expect(response.status, code).toBe(status);
      expect(response.headers.get("cache-control"), code).toBe("private, no-store");
      expect(response.headers.get("content-type"), code).toContain("application/json");
      expect(response.headers.get("x-correlation-id"), code).toBe(correlationId);
      expect(body).toEqual({
        ok: false,
        error: { ...apiError(code, correlationId), retryable },
      });
    }
  });

  it("mapeia causas conhecidas e falha fechado para erro interno", () => {
    let zodError: unknown;
    try {
      z.string().parse(42);
    } catch (error) {
      zodError = error;
    }

    expect(errorCodeFromUnknown(zodError)).toBe("VALIDATION_ERROR");
    expect(errorCodeFromUnknown(new ApplicationError("AI_TIMEOUT"))).toBe("AI_TIMEOUT");
    expect(errorCodeFromUnknown(new Error("NOT_FOUND"))).toBe("NOT_FOUND");
    expect(errorCodeFromUnknown(new Error("database password=secret"))).toBe("INTERNAL_ERROR");
    expect(errorCodeFromUnknown({ code: "AUTHORIZATION_ERROR" })).toBe("INTERNAL_ERROR");
  });

  it("não serializa causa, credencial ou mensagem interna na resposta pública", async () => {
    const internal = new ApplicationError("DATABASE_ERROR", {
      cause: new Error("postgresql://127.0.0.1:5432/preco_test"),
      message: "senha=segredo",
    });
    const response = apiErrorResponse(errorCodeFromUnknown(internal), correlationId);
    const encoded = JSON.stringify(await response.json());

    expect(encoded).not.toContain("secret");
    expect(encoded).not.toContain("segredo");
    expect(encoded).not.toContain("postgresql://");
  });
});
