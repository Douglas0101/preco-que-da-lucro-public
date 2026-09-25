/**
 * Memory Service — degrau D1: candidato → decisão, **sem persistência**.
 *
 * O modelo (ou uma tool, ou o usuário) propõe um candidato; o backend decide
 * pela `MemoryPolicy` antes de qualquer gravação (§15.3) e devolve a proposta
 * canônica. A gravação/retrieval chegam em D2 pelo `MemoryRepositoryPort`, com
 * `RequestContext` — por isso este serviço não importa `@/db` nem `drizzle-orm`
 * e não consome nada do Financial Engine (INV-004/INV-005).
 */
import type {
  MemoryCandidate,
  MemoryPolicy,
  MemoryStatus,
} from "@/server/contracts/memory.contracts";
import { evaluateMemoryPolicy, memoryPolicyError } from "@/server/services/memory.policy";

export interface MemoryProposeOptions {
  /** Relógio injetado (§29 — determinismo em teste; produção usa `new Date()`). */
  readonly now?: Date;
}

export interface MemoryProposal {
  /** Candidato canônico aprovado pela policy (`content` normalizado). */
  readonly candidate: MemoryCandidate;
  readonly status: MemoryStatus;
  /** Derivado de `policy.retention.ttlSeconds`; `null` = sem expiração. */
  readonly expiresAt: Date | null;
}

export interface MemoryService {
  propose(
    candidate: MemoryCandidate,
    policy: MemoryPolicy,
    options?: MemoryProposeOptions,
  ): MemoryProposal;
}

export class DefaultMemoryService implements MemoryService {
  propose(
    candidate: MemoryCandidate,
    policy: MemoryPolicy,
    options?: MemoryProposeOptions,
  ): MemoryProposal {
    const decision = evaluateMemoryPolicy(policy, candidate);
    if (!decision.accepted) throw memoryPolicyError(decision);

    const now = options?.now ?? new Date();
    const ttlSeconds = policy.retention.ttlSeconds;

    return {
      candidate: decision.value,
      status: "active",
      expiresAt: ttlSeconds === null ? null : new Date(now.getTime() + ttlSeconds * 1000),
    };
  }
}

export const memoryService: MemoryService = new DefaultMemoryService();
