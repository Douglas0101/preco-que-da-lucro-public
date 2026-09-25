import { describe, expect, it } from "vitest";
import { assertGatewayEndpoint } from "@/lib/ai-endpoint.server";
import { ApplicationError } from "@/lib/api-error";

const GUARD_REJECTION = "AI gateway endpoint recusado pelo guard (https público obrigatório):";

/** Captura a recusa e garante que o motivo aparece na mensagem do erro. */
function expectRejected(endpoint: string, messageFragment: string): void {
  let error: unknown;
  try {
    assertGatewayEndpoint(endpoint);
  } catch (caught) {
    error = caught;
  }
  expect(error, `endpoint deveria ser recusado: ${endpoint}`).toBeInstanceOf(ApplicationError);
  const appError = error as ApplicationError;
  expect(appError.code).toBe("DEPENDENCY_ERROR");
  expect(appError.message).toContain(GUARD_REJECTION);
  expect(appError.message).toContain(messageFragment);
}

describe("assertGatewayEndpoint (guard anti-SSRF do AI gateway, G-SEC #10-13)", () => {
  it("aceita o gateway default da Lovable", () => {
    const url = assertGatewayEndpoint("https://ai.gateway.lovable.dev/v1/chat/completions");
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("ai.gateway.lovable.dev");
    expect(url.pathname).toBe("/v1/chat/completions");
  });

  it("aceita hostname público configurado pelo operador", () => {
    const url = assertGatewayEndpoint("https://gateway-custom.exemplo.org/v1");
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("gateway-custom.exemplo.org");
    expect(url.pathname).toBe("/v1");
  });

  it("recusa protocolo não-https", () => {
    expectRejected("http://ai.gateway.lovable.dev/", 'protocolo "http:" não suportado');
  });

  it("recusa endpoint não-URL com cause clara", () => {
    let error: unknown;
    try {
      assertGatewayEndpoint("não-é-url");
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(ApplicationError);
    const appError = error as ApplicationError;
    expect(appError.code).toBe("DEPENDENCY_ERROR");
    expect(appError.message).toBe(`${GUARD_REJECTION} URL inválida: não-é-url`);
    expect(appError.cause).toBeInstanceOf(Error);
  });

  it("recusa IP literal de qualquer faixa, incluindo loopback e link-local", () => {
    expectRejected("http://169.254.169.254/", 'protocolo "http:" não suportado');
    expectRejected("https://169.254.169.254/", "endereço IP literal não permitido");
    expectRejected("https://127.0.0.1/", "endereço IP literal não permitido");
    expectRejected("https://192.168.1.5/", "endereço IP literal não permitido");
    expectRejected("https://10.0.0.1/", "endereço IP literal não permitido");
  });

  it("recusa IPv6 literal e formas numéricas canônicas de IPv4", () => {
    expectRejected("https://[::1]/", "endereço IPv6 literal não permitido");
    expectRejected("https://0x7f000001/", "endereço IP literal não permitido");
    expectRejected("https://127.1/", "endereço IP literal não permitido");
  });

  it("recusa hosts internos e de resolução local", () => {
    expectRejected("https://localhost:8080/", "host localhost não permitido");
    expectRejected("https://gateway.local/", "host .local não permitido");
    expectRejected("https://metadata.google.internal/", "host .internal não permitido");
  });
});
