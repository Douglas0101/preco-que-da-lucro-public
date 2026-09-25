import { ZodError } from "zod";

export const API_ERROR_CODES = [
  "VALIDATION_ERROR",
  "AUTHENTICATION_ERROR",
  "AUTHORIZATION_ERROR",
  "NOT_FOUND",
  "CONFLICT",
  "RATE_LIMIT",
  "DATABASE_ERROR",
  "DEPENDENCY_ERROR",
  "AI_TIMEOUT",
  "AI_QUOTA",
  "INTERNAL_ERROR",
] as const;

export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export interface ApiError {
  code: ApiErrorCode;
  message: string;
  retryable: boolean;
  correlationId: string;
}

export type ApiResult<T> = { ok: true; data: T } | { ok: false; error: ApiError };

const DOMAIN_VALIDATION_PREFIXES = [
  "INVALID_",
  "NON_",
  "DECIMAL_",
  "SIMULATION_",
  "SALE_",
] as const;

function isDomainValidationCode(value: string): boolean {
  return DOMAIN_VALIDATION_PREFIXES.some((prefix) => value.startsWith(prefix));
}

const ERROR_POLICY: Record<ApiErrorCode, { status: number; message: string; retryable: boolean }> =
  {
    VALIDATION_ERROR: { status: 400, message: "Revise os dados informados.", retryable: false },
    AUTHENTICATION_ERROR: { status: 401, message: "Faça login para continuar.", retryable: false },
    AUTHORIZATION_ERROR: {
      status: 403,
      message: "Você não pode realizar esta ação.",
      retryable: false,
    },
    NOT_FOUND: {
      status: 404,
      message: "O recurso solicitado não foi encontrado.",
      retryable: false,
    },
    CONFLICT: { status: 409, message: "A operação conflita com o estado atual.", retryable: false },
    RATE_LIMIT: {
      status: 429,
      message: "Muitas solicitações. Aguarde e tente novamente.",
      retryable: true,
    },
    DATABASE_ERROR: { status: 503, message: "Não foi possível acessar os dados.", retryable: true },
    DEPENDENCY_ERROR: {
      status: 503,
      message: "Um serviço necessário está indisponível.",
      retryable: true,
    },
    AI_TIMEOUT: { status: 504, message: "A IA demorou mais que o permitido.", retryable: true },
    AI_QUOTA: {
      status: 429,
      message: "O orçamento de IA deste período foi atingido.",
      retryable: false,
    },
    INTERNAL_ERROR: {
      status: 500,
      message: "Não foi possível concluir a solicitação.",
      retryable: false,
    },
  };

export class ApplicationError extends Error {
  readonly code: ApiErrorCode;
  readonly retryable: boolean;
  readonly status: number;

  constructor(code: ApiErrorCode, options: { cause?: unknown; message?: string } = {}) {
    const policy = ERROR_POLICY[code];
    super(options.message ?? policy.message, { cause: options.cause });
    this.name = "ApplicationError";
    this.code = code;
    this.retryable = policy.retryable;
    this.status = policy.status;
  }
}

export function apiError(code: ApiErrorCode, correlationId: string): ApiError {
  const policy = ERROR_POLICY[code];
  return { code, message: policy.message, retryable: policy.retryable, correlationId };
}

export function errorCodeFromUnknown(error: unknown): ApiErrorCode {
  if (error instanceof ZodError) return "VALIDATION_ERROR";
  if (error instanceof ApplicationError) return error.code;
  if (error instanceof Error) {
    const message = error.message.trim();
    if (API_ERROR_CODES.includes(message as ApiErrorCode)) return message as ApiErrorCode;
    if (isDomainValidationCode(message)) return "VALIDATION_ERROR";
  }
  return "INTERNAL_ERROR";
}

export function apiErrorResponse(code: ApiErrorCode, correlationId: string): Response {
  const policy = ERROR_POLICY[code];
  const body = JSON.stringify({
    ok: false,
    error: apiError(code, correlationId),
  } satisfies ApiResult<never>);
  return new Response(body, {
    status: policy.status,
    headers: {
      "cache-control": "private, no-store",
      "content-length": String(new TextEncoder().encode(body).byteLength),
      "content-type": "application/json; charset=utf-8",
      "x-correlation-id": correlationId,
      vary: "Cookie",
    },
  });
}
