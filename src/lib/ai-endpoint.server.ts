import { ApplicationError } from "@/lib/api-error";

const GUARD_REJECTION_PREFIX =
  "AI gateway endpoint recusado pelo guard (https público obrigatório):";

/**
 * Negue por padrão qualquer IP literal (loopback, link-local 169.254.x, RFC1918
 * e demais): o AI gateway é hostname público, nunca endereço numérico. O parser
 * WHATWG canonicaliza toda forma numérica de IPv4 (decimal, octal, hex, curta —
 * ex.: `0x7f000001`, `127.1`) para dotted-quad antes desta checagem, e IPv6
 * chega com brackets/":" — os dois formatos abaixo cobrem os bypasses clássicos.
 */
function isDottedQuadIpv4(host: string): boolean {
  const octets = host.split(".");
  if (octets.length !== 4) return false;
  return octets.every((octet) => /^\d{1,3}$/.test(octet) && Number(octet) <= 255);
}

function deny(reason: string, host: string): never {
  throw new ApplicationError("DEPENDENCY_ERROR", {
    message: `${GUARD_REJECTION_PREFIX} ${reason} ${host}`,
  });
}

/**
 * Guard anti-SSRF na origem das chamadas ao AI gateway (findings G-SEC #10-13,
 * triagem em docs/evidence/gsec-2026-09-06/): um único ponto que valida o
 * endpoint resolvido de `process.env.AI_GATEWAY_URL` antes de qualquer `fetch`.
 * Aceita somente https com hostname público; recusa IP literal (loopback,
 * link-local, RFC1918, v4/v6), localhost, *.localhost, *.local e *.internal.
 * Operador pode apontar para outro hostname público — nunca para a rede interna.
 */
export function assertGatewayEndpoint(endpoint: string): URL {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch (error) {
    throw new ApplicationError("DEPENDENCY_ERROR", {
      message: `${GUARD_REJECTION_PREFIX} URL inválida: ${endpoint}`,
      cause: error,
    });
  }
  if (url.protocol !== "https:") {
    deny(`protocolo "${url.protocol}" não suportado (somente https):`, url.hostname || "(vazio)");
  }
  const hostname = url.hostname;
  const bareHost =
    hostname.startsWith("[") && hostname.endsWith("]") ? hostname.slice(1, -1) : hostname;
  if (bareHost.length === 0) {
    deny("hostname vazio:", "(sem host)");
  }
  if (bareHost.includes(":")) {
    deny("endereço IPv6 literal não permitido:", hostname);
  }
  if (isDottedQuadIpv4(bareHost)) {
    deny("endereço IP literal não permitido (inclui loopback, link-local e RFC1918):", hostname);
  }
  const name = bareHost.endsWith(".") ? bareHost.slice(0, -1) : bareHost;
  if (name === "localhost" || name.endsWith(".localhost")) {
    deny("host localhost não permitido:", hostname);
  }
  if (name.endsWith(".local")) {
    deny("host .local não permitido:", hostname);
  }
  if (name.endsWith(".internal")) {
    deny("host .internal não permitido:", hostname);
  }
  return url;
}
