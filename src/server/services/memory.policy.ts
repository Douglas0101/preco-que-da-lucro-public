/**
 * Avaliação de `MemoryPolicy` (§15.3 — o modelo propõe, o backend decide).
 *
 * Módulo puro e sem persistência: recebe a política e o candidato e devolve uma
 * decisão discriminada. **Todos** os limites vêm dos dados de `MemoryPolicy`
 * (nada de constante embutida) e a decisão é determinística — a mesma entrada
 * produz sempre a mesma saída, com precedência fixa:
 *
 *   policy → escopo → conteúdo → proveniência → confiança → importância
 *
 * INVs respeitados: nada aqui lê dado financeiro (INV-004) e nada aqui grava
 * (a persistência chega em D2 pelo repositório).
 */
import { ApplicationError, type ApiErrorCode } from "@/lib/api-error";
import type {
  MemoryCandidate,
  MemoryPolicy,
  MemoryProvenance,
} from "@/server/contracts/memory.contracts";

export type MemoryRejectionReason =
  | "INVALID_POLICY"
  | "INVALID_REQUESTED_LIMIT"
  | "SCOPE_NOT_ALLOWED"
  | "CONTENT_EMPTY"
  | "CONTENT_TOO_LONG"
  | "PROVENANCE_REQUIRED"
  | "CONFIDENCE_OUT_OF_RANGE"
  | "CONFIDENCE_BELOW_MINIMUM"
  | "IMPORTANCE_OUT_OF_RANGE";

export interface MemoryPolicyAcceptance {
  readonly accepted: true;
  /** Candidato canônico: `content` já normalizado (NFC + trim). */
  readonly value: MemoryCandidate;
}

export interface MemoryPolicyRejection {
  readonly accepted: false;
  readonly reason: MemoryRejectionReason;
  readonly detail: string;
}

export type MemoryPolicyDecision = MemoryPolicyAcceptance | MemoryPolicyRejection;

/** Faixa canônica de confiança/importância (§34: `CHECK ... ∈ [0,1]`). */
const inUnitRange = (value: number): boolean => Number.isFinite(value) && value >= 0 && value <= 1;

/** Falha fechado: política com número não finito/fora de domínio tornaria as
 * comparações silenciosamente vacuosas (ex.: `NaN < minConfidence` é falso). */
function invalidPolicyDetail(policy: MemoryPolicy): string | null {
  if (!inUnitRange(policy.minConfidence)) return "minConfidence fora de [0,1]";
  if (!Number.isInteger(policy.maxContentLength) || policy.maxContentLength < 1) {
    return "maxContentLength não é inteiro positivo";
  }
  if (!Number.isInteger(policy.maxResults) || policy.maxResults < 1) {
    return "maxResults não é inteiro positivo";
  }
  const ttlSeconds = policy.retention.ttlSeconds;
  if (ttlSeconds !== null && (!Number.isFinite(ttlSeconds) || ttlSeconds < 0)) {
    return "retention.ttlSeconds não é nulo nem finito não negativo";
  }
  if (!Number.isFinite(policy.ranking.recency) || policy.ranking.recency < 0) {
    return "ranking.recency não é finito não negativo";
  }
  if (!Number.isFinite(policy.ranking.importance) || policy.ranking.importance < 0) {
    return "ranking.importance não é finito não negativo";
  }
  if (!Number.isFinite(policy.ranking.confidence) || policy.ranking.confidence < 0) {
    return "ranking.confidence não é finito não negativo";
  }
  return null;
}

/** Proveniência utilizável: identifica uma origem e um instante reais. Um
 * registro sem origem é proveniência ausente na prática (§15.4). */
function hasUsableProvenance(provenance: MemoryProvenance | undefined): boolean {
  return (
    provenance !== undefined &&
    provenance.sourceId.trim() !== "" &&
    Number.isFinite(provenance.capturedAt.getTime())
  );
}

function reject(reason: MemoryRejectionReason, detail: string): MemoryPolicyRejection {
  return { accepted: false, reason, detail };
}

/** Mapeamento único de rejeição → taxonomia de erro existente (`src/lib/api-error.ts`):
 * candidato inválido é erro do chamador; política inválida é falha do servidor. */
const ERROR_CODE_BY_REASON: Record<MemoryRejectionReason, ApiErrorCode> = {
  INVALID_POLICY: "INTERNAL_ERROR",
  INVALID_REQUESTED_LIMIT: "VALIDATION_ERROR",
  SCOPE_NOT_ALLOWED: "VALIDATION_ERROR",
  CONTENT_EMPTY: "VALIDATION_ERROR",
  CONTENT_TOO_LONG: "VALIDATION_ERROR",
  PROVENANCE_REQUIRED: "VALIDATION_ERROR",
  CONFIDENCE_OUT_OF_RANGE: "VALIDATION_ERROR",
  CONFIDENCE_BELOW_MINIMUM: "VALIDATION_ERROR",
  IMPORTANCE_OUT_OF_RANGE: "VALIDATION_ERROR",
};

export function memoryPolicyError(rejection: MemoryPolicyRejection): ApplicationError {
  return new ApplicationError(ERROR_CODE_BY_REASON[rejection.reason], {
    message: `candidato de memória rejeitado pela policy: ${rejection.reason} (${rejection.detail})`,
    cause: { reason: rejection.reason },
  });
}

/** Decide se o candidato entra na memória sob a política dada, devolvendo o
 * candidato canônico quando aceito. Nunca lança: a rejeição é dado. */
export function evaluateMemoryPolicy(
  policy: MemoryPolicy,
  candidate: MemoryCandidate,
): MemoryPolicyDecision {
  const policyProblem = invalidPolicyDetail(policy);
  if (policyProblem !== null) return reject("INVALID_POLICY", policyProblem);

  if (!policy.allowedScopes.includes(candidate.scope)) {
    return reject(
      "SCOPE_NOT_ALLOWED",
      `escopo ${candidate.scope} fora de [${policy.allowedScopes.join(", ")}]`,
    );
  }

  // Normalização §15.5: NFC para comparar acentos de forma estável e trim porque
  // espaço de borda não é conteúdo. O limite é medido sobre a forma canônica.
  const content = candidate.content.normalize("NFC").trim();
  if (content === "") return reject("CONTENT_EMPTY", "conteúdo vazio após normalização");
  if (content.length > policy.maxContentLength) {
    return reject(
      "CONTENT_TOO_LONG",
      `${content.length} > maxContentLength ${policy.maxContentLength}`,
    );
  }

  const provenance = candidate.provenance;
  if (policy.requireProvenance && !hasUsableProvenance(provenance)) {
    return reject("PROVENANCE_REQUIRED", "proveniência ausente ou sem origem identificável");
  }

  // Sem proveniência (permitida quando `requireProvenance = false`) não há
  // confiança declarada a comparar com `minConfidence`.
  const confidence = provenance?.confidence;
  if (confidence !== undefined) {
    if (!inUnitRange(confidence)) {
      return reject("CONFIDENCE_OUT_OF_RANGE", `confidence fora de [0,1]: ${confidence}`);
    }
    if (confidence < policy.minConfidence) {
      return reject(
        "CONFIDENCE_BELOW_MINIMUM",
        `${confidence} < minConfidence ${policy.minConfidence}`,
      );
    }
  }

  const importance = candidate.importance;
  if (importance !== undefined && !inUnitRange(importance)) {
    return reject("IMPORTANCE_OUT_OF_RANGE", `importance fora de [0,1]: ${importance}`);
  }

  return { accepted: true, value: { ...candidate, content } };
}

/** Teto efetivo de retrieval (§15.7/D6): o pedido do chamador nunca amplia
 * `maxResults` — apenas reduz. */
export function resolveMemoryResultLimit(policy: MemoryPolicy, requested?: number): number {
  const policyProblem = invalidPolicyDetail(policy);
  if (policyProblem !== null) throw memoryPolicyError(reject("INVALID_POLICY", policyProblem));

  if (requested === undefined) return policy.maxResults;
  if (!Number.isInteger(requested) || requested < 1) {
    throw memoryPolicyError(
      reject("INVALID_REQUESTED_LIMIT", `limite pedido inválido: ${requested}`),
    );
  }
  return Math.min(requested, policy.maxResults);
}
