import { describe, expect, it } from "vitest";
import { ApplicationError } from "@/lib/api-error";
import type {
  MemoryCandidate,
  MemoryPolicy,
  MemoryProvenance,
} from "@/server/contracts/memory.contracts";
import { DefaultMemoryService, memoryService } from "@/server/services/memory.service";

const POLICY: MemoryPolicy = {
  allowedScopes: ["conversation", "user"],
  minConfidence: 0.5,
  requireProvenance: true,
  maxContentLength: 40,
  maxResults: 5,
  retention: { ttlSeconds: null },
  ranking: { recency: 0.4, importance: 0.3, confidence: 0.3 },
};

function policy(overrides: Partial<MemoryPolicy> = {}): MemoryPolicy {
  return { ...POLICY, ...overrides };
}

function provenance(overrides: Partial<MemoryProvenance> = {}): MemoryProvenance {
  return {
    sourceKind: "user",
    sourceId: "message-1",
    conversationId: "conversation-1",
    capturedAt: new Date("2026-09-16T00:00:00.000Z"),
    inferred: false,
    confidence: 0.9,
    ...overrides,
  };
}

function candidate(overrides: Partial<MemoryCandidate> = {}): MemoryCandidate {
  return {
    scope: "conversation",
    content: "margem de contribuição do produto",
    provenance: provenance(),
    ...overrides,
  };
}

function memoryRejection(run: () => unknown): ApplicationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ApplicationError);
    return error as ApplicationError;
  }
  throw new Error("esperava rejeição do serviço com erro da taxonomia existente");
}

describe("MemoryService.propose — rejeições com erro tipado", () => {
  it("serviço exportado implementa a porta pela classe padrão", () => {
    expect(memoryService).toBeInstanceOf(DefaultMemoryService);
  });

  const REJECTIONS: Array<[string, MemoryPolicy, MemoryCandidate]> = [
    [
      "(a) confiança abaixo do mínimo",
      policy({ minConfidence: 0.8 }),
      candidate({ provenance: provenance({ confidence: 0.79 }) }),
    ],
    [
      "(b) escopo fora de allowedScopes",
      policy({ allowedScopes: ["user"] }),
      candidate({ scope: "tenant" }),
    ],
    [
      "(c) proveniência ausente com requireProvenance = true",
      policy({ requireProvenance: true }),
      candidate({ provenance: undefined }),
    ],
    [
      "(d) conteúdo acima de maxContentLength",
      policy({ maxContentLength: 10 }),
      candidate({ content: "a".repeat(11) }),
    ],
  ];

  it.each(REJECTIONS)(
    "rejeita %s com VALIDATION_ERROR",
    (_label, policyUnderTest, candidateUnderTest) => {
      const error = memoryRejection(() =>
        memoryService.propose(candidateUnderTest, policyUnderTest),
      );

      expect(error.code).toBe("VALIDATION_ERROR");
      expect(error.status).toBe(400);
      expect(error.retryable).toBe(false);
      expect(error.message).not.toBe("");
    },
  );

  it("não consulta o banco: a rejeição acontece antes de qualquer persistência", () => {
    const error = memoryRejection(() =>
      memoryService.propose(candidate({ scope: "tenant" }), policy({ allowedScopes: ["user"] })),
    );

    expect(error.code).toBe("VALIDATION_ERROR");
  });

  it("policy inválida é falha de servidor (INTERNAL_ERROR), não de candidato", () => {
    const error = memoryRejection(() =>
      memoryService.propose(candidate(), policy({ minConfidence: Number.NaN })),
    );

    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.status).toBe(500);
  });

  it("não muta o candidato recebido ao rejeitar", () => {
    const received = candidate({ content: "   ", provenance: provenance({ confidence: 0.9 }) });

    expect(() => memoryService.propose(received, policy())).toThrow(ApplicationError);
    expect(received.content).toBe("   ");
  });
});

describe("MemoryService.propose — aceitação e normalização", () => {
  it("normaliza trim + NFC preservando inferred/confidence intactos", () => {
    const raw = "  Cafe\u0301 com   espac\u0327os  ";
    expect(raw.normalize("NFC")).not.toBe(raw);

    const receivedProvenance = provenance({
      sourceKind: "model",
      inferred: true,
      confidence: 0.73,
    });
    const proposal = memoryService.propose(
      candidate({ content: raw, provenance: receivedProvenance }),
      policy(),
    );

    expect(proposal.candidate.content).toBe("Café com   espaços");
    expect(proposal.candidate.provenance).toEqual(receivedProvenance);
    expect(proposal.candidate.provenance?.inferred).toBe(true);
    expect(proposal.candidate.provenance?.confidence).toBe(0.73);
  });

  it("não muta o candidato recebido ao aceitar", () => {
    const received = candidate({ content: "  margem  " });
    const before = structuredClone(received);

    memoryService.propose(received, policy());

    expect(received).toEqual(before);
  });

  it("a proposta nasce ativa", () => {
    const proposal = memoryService.propose(candidate(), policy());

    expect(proposal.status).toBe("active");
  });

  it("preserva scope e importance aprovados", () => {
    const proposal = memoryService.propose(
      candidate({ scope: "user", importance: 0.25 }),
      policy(),
    );

    expect(proposal.candidate.scope).toBe("user");
    expect(proposal.candidate.importance).toBe(0.25);
  });
});

describe("MemoryService.propose — retenção vem da policy (dados)", () => {
  const now = new Date("2026-09-16T12:00:00.000Z");

  it("sem TTL na policy, a proposta não expira", () => {
    const proposal = memoryService.propose(
      candidate(),
      policy({ retention: { ttlSeconds: null } }),
      { now },
    );

    expect(proposal.expiresAt).toBeNull();
  });

  it("TTL da policy determina expiresAt a partir do relógio injetado", () => {
    const proposal = memoryService.propose(
      candidate(),
      policy({ retention: { ttlSeconds: 3600 } }),
      { now },
    );

    expect(proposal.expiresAt?.toISOString()).toBe("2026-09-16T13:00:00.000Z");
  });

  it("mesma política e mesmo relógio ⇒ mesmo expiresAt (determinístico)", () => {
    const first = memoryService.propose(candidate(), policy({ retention: { ttlSeconds: 60 } }), {
      now,
    });
    const second = memoryService.propose(candidate(), policy({ retention: { ttlSeconds: 60 } }), {
      now,
    });

    expect(first.expiresAt?.toISOString()).toBe(second.expiresAt?.toISOString());
  });

  it("TTL inválido na policy falha fechado", () => {
    const error = memoryRejection(() =>
      memoryService.propose(candidate(), policy({ retention: { ttlSeconds: Number.NaN } }), {
        now,
      }),
    );

    expect(error.code).toBe("INTERNAL_ERROR");
  });
});
