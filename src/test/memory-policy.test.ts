import { describe, expect, it } from "vitest";
import { ApplicationError } from "@/lib/api-error";
import type {
  MemoryCandidate,
  MemoryPolicy,
  MemoryProvenance,
} from "@/server/contracts/memory.contracts";
import {
  evaluateMemoryPolicy,
  resolveMemoryResultLimit,
  type MemoryPolicyRejection,
} from "@/server/services/memory.policy";

/** Política base dos fixtures: os limites são **dados** — cada teste troca um
 * campo e o veredito muda, provando que nada está embutido no código. */
const BASE_POLICY: MemoryPolicy = {
  allowedScopes: ["conversation", "user"],
  minConfidence: 0.5,
  requireProvenance: true,
  maxContentLength: 40,
  maxResults: 5,
  retention: { ttlSeconds: null },
  ranking: { recency: 0.4, importance: 0.3, confidence: 0.3 },
};

function policy(overrides: Partial<MemoryPolicy> = {}): MemoryPolicy {
  return { ...BASE_POLICY, ...overrides };
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

function rejectionReasons(
  policyUnderTest: MemoryPolicy,
  candidateUnderTest: MemoryCandidate,
): MemoryPolicyRejection {
  const decision = evaluateMemoryPolicy(policyUnderTest, candidateUnderTest);
  if (decision.accepted) throw new Error("esperava rejeição da policy");
  return decision;
}

function validationError(run: () => unknown): ApplicationError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(ApplicationError);
    return error as ApplicationError;
  }
  throw new Error("esperava ApplicationError da taxonomia existente");
}

describe("evaluateMemoryPolicy — (a) confiança mínima", () => {
  it("rejeita candidato com confidence abaixo de minConfidence", () => {
    const decision = rejectionReasons(
      policy({ minConfidence: 0.8 }),
      candidate({ provenance: provenance({ confidence: 0.79 }) }),
    );

    expect(decision).toEqual({
      accepted: false,
      reason: "CONFIDENCE_BELOW_MINIMUM",
      detail: expect.any(String),
    });
  });

  it("aceita exatamente no limite (minConfidence é inclusivo)", () => {
    const decision = evaluateMemoryPolicy(
      policy({ minConfidence: 0.5 }),
      candidate({ provenance: provenance({ confidence: 0.5 }) }),
    );

    expect(decision.accepted).toBe(true);
  });

  it("trata confiança fora de [0,1] ou não finita como rejeição, não como compare silencioso", () => {
    for (const confidence of [Number.NaN, 1.01, -0.01, Number.POSITIVE_INFINITY]) {
      const decision = rejectionReasons(
        policy(),
        candidate({ provenance: provenance({ confidence }) }),
      );
      expect(decision.reason).toBe("CONFIDENCE_OUT_OF_RANGE");
    }
  });
});

describe("evaluateMemoryPolicy — (b) escopo permitido", () => {
  it("rejeita scope fora de allowedScopes", () => {
    const decision = rejectionReasons(
      policy({ allowedScopes: ["user"] }),
      candidate({ scope: "tenant" }),
    );

    expect(decision).toEqual({
      accepted: false,
      reason: "SCOPE_NOT_ALLOWED",
      detail: expect.any(String),
    });
  });

  it("aceita todo scope presente em allowedScopes", () => {
    for (const scope of BASE_POLICY.allowedScopes) {
      expect(evaluateMemoryPolicy(policy(), candidate({ scope })).accepted).toBe(true);
    }
  });
});

describe("evaluateMemoryPolicy — (c) proveniência obrigatória", () => {
  it("rejeita ausência de proveniência quando requireProvenance = true", () => {
    const decision = rejectionReasons(
      policy({ requireProvenance: true }),
      candidate({ provenance: undefined }),
    );

    expect(decision).toEqual({
      accepted: false,
      reason: "PROVENANCE_REQUIRED",
      detail: expect.any(String),
    });
  });

  it("rejeita proveniência que não identifica origem (sourceId em branco)", () => {
    const decision = rejectionReasons(
      policy({ requireProvenance: true }),
      candidate({ provenance: provenance({ sourceId: "   " }) }),
    );

    expect(decision.reason).toBe("PROVENANCE_REQUIRED");
  });

  it("rejeita proveniência com instante inválido (quando/ausente não é proveniência)", () => {
    const decision = rejectionReasons(
      policy({ requireProvenance: true }),
      candidate({ provenance: provenance({ capturedAt: new Date(Number.NaN) }) }),
    );

    expect(decision.reason).toBe("PROVENANCE_REQUIRED");
  });

  it("aceita ausência de proveniência quando a policy não a exige", () => {
    const decision = evaluateMemoryPolicy(
      policy({ requireProvenance: false }),
      candidate({ provenance: undefined }),
    );

    expect(decision.accepted).toBe(true);
  });
});

describe("evaluateMemoryPolicy — (d) tamanho máximo de conteúdo", () => {
  it("rejeita conteúdo acima de maxContentLength", () => {
    const decision = rejectionReasons(
      policy({ maxContentLength: 40 }),
      candidate({ content: "a".repeat(41) }),
    );

    expect(decision).toEqual({
      accepted: false,
      reason: "CONTENT_TOO_LONG",
      detail: expect.any(String),
    });
  });

  it("aceita exatamente no limite", () => {
    expect(
      evaluateMemoryPolicy(policy({ maxContentLength: 40 }), candidate({ content: "a".repeat(40) }))
        .accepted,
    ).toBe(true);
  });

  it("mede o limite sobre o conteúdo normalizado, não sobre o texto cru", () => {
    const padded = `${" ".repeat(200)}ok${" ".repeat(200)}`;

    expect(
      evaluateMemoryPolicy(policy({ maxContentLength: 40 }), candidate({ content: padded }))
        .accepted,
    ).toBe(true);
  });

  it("rejeita conteúdo vazio (inclusive só espaços) como vazio, não como longo", () => {
    const decision = rejectionReasons(policy(), candidate({ content: "   " }));

    expect(decision.reason).toBe("CONTENT_EMPTY");
  });
});

describe("evaluateMemoryPolicy — (e) normalização preservando proveniência", () => {
  it("normaliza trim + NFC e preserva inferred/confidence intactos", () => {
    const raw = "  Cafe\u0301 com   espac\u0327os  ";
    // Poder discriminante: o fixture precisa estar em NFD, senão a asserção de NFC seria vacua.
    expect(raw.normalize("NFC")).not.toBe(raw);

    const inputProvenance = provenance({ inferred: true, confidence: 0.73, sourceKind: "model" });
    const decision = evaluateMemoryPolicy(
      policy(),
      candidate({ content: raw, provenance: inputProvenance }),
    );

    expect(decision.accepted).toBe(true);
    if (!decision.accepted) return;
    expect(decision.value.content).toBe("Café com   espaços");
    expect(decision.value.provenance).toEqual(inputProvenance);
    expect(decision.value.provenance?.inferred).toBe(true);
    expect(decision.value.provenance?.confidence).toBe(0.73);
  });

  it("não colapsa espaço interno nem reescreve o restante do candidato", () => {
    const decision = evaluateMemoryPolicy(
      policy({ maxContentLength: 80 }),
      candidate({ content: "  a   b  ", importance: 0.6 }),
    );

    expect(decision.accepted).toBe(true);
    if (!decision.accepted) return;
    expect(decision.value.content).toBe("a   b");
    expect(decision.value.scope).toBe("conversation");
    expect(decision.value.importance).toBe(0.6);
  });

  it("rejeita importance fora de [0,1] quando informada", () => {
    for (const importance of [1.2, -0.1, Number.NaN]) {
      const decision = rejectionReasons(policy(), candidate({ importance }));
      expect(decision.reason).toBe("IMPORTANCE_OUT_OF_RANGE");
    }
  });
});

describe("evaluateMemoryPolicy — limites vêm da policy (dados), não de constantes", () => {
  it("mesmo candidato: rejeitado sob policy estrita, aceito sob policy permissiva", () => {
    const content = "a".repeat(60);

    expect(
      evaluateMemoryPolicy(policy({ maxContentLength: 20 }), candidate({ content })).accepted,
    ).toBe(false);
    expect(
      evaluateMemoryPolicy(policy({ maxContentLength: 100 }), candidate({ content })).accepted,
    ).toBe(true);
  });

  it("precedência determinística: escopo antes de conteúdo e de confiança", () => {
    const decision = rejectionReasons(
      policy({ allowedScopes: ["user"], maxContentLength: 5, minConfidence: 0.9 }),
      candidate({
        scope: "tenant",
        content: "muito maior que o limite",
        provenance: provenance({ confidence: 0.1 }),
      }),
    );

    expect(decision.reason).toBe("SCOPE_NOT_ALLOWED");

    const contentFirst = rejectionReasons(
      policy({ maxContentLength: 5, minConfidence: 0.9 }),
      candidate({
        content: "muito maior que o limite",
        provenance: provenance({ confidence: 0.1 }),
      }),
    );

    expect(contentFirst.reason).toBe("CONTENT_TOO_LONG");
  });

  it("proveniência precede confiança: candidato sem origem e com confiança baixa reporta PROVENANCE_REQUIRED", () => {
    const decision = rejectionReasons(
      policy({ requireProvenance: true, minConfidence: 0.9 }),
      candidate({ provenance: undefined }),
    );

    expect(decision.reason).toBe("PROVENANCE_REQUIRED");
  });
});

const INVALID_POLICIES: Array<[string, Partial<MemoryPolicy>]> = [
  ["minConfidence não finita", { minConfidence: Number.NaN }],
  ["minConfidence acima de 1", { minConfidence: 1.5 }],
  ["maxContentLength zero", { maxContentLength: 0 }],
  ["maxResults fracionário", { maxResults: 2.5 }],
  ["ttl negativo", { retention: { ttlSeconds: -1 } }],
  [
    "peso de ranking não finito",
    { ranking: { recency: Number.NaN, importance: 0.3, confidence: 0.3 } },
  ],
];

describe("evaluateMemoryPolicy — policy inválida falha fechado", () => {
  it.each(INVALID_POLICIES)("rejeita %s com INVALID_POLICY", (_label, override) => {
    const decision = rejectionReasons(policy(override), candidate());

    expect(decision.reason).toBe("INVALID_POLICY");
  });
});

describe("resolveMemoryResultLimit — teto da policy é o limite efetivo", () => {
  it("usa maxResults quando o chamador não pede limite", () => {
    expect(resolveMemoryResultLimit(policy({ maxResults: 5 }), undefined)).toBe(5);
  });

  it("nunca amplia acima de maxResults", () => {
    expect(resolveMemoryResultLimit(policy({ maxResults: 5 }), 100)).toBe(5);
  });

  it("respeita pedido menor que o teto", () => {
    expect(resolveMemoryResultLimit(policy({ maxResults: 5 }), 3)).toBe(3);
  });

  it.each([0, -1, 1.5, Number.NaN, 0.5])("rejeita limite pedido inválido (%s)", (requested) => {
    const error = validationError(() => resolveMemoryResultLimit(policy(), requested));

    expect(error.code).toBe("VALIDATION_ERROR");
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("ApplicationError");
  });

  it("invalida policy com maxResults não positivo antes de calcular o limite", () => {
    expect(() => resolveMemoryResultLimit(policy({ maxResults: 0 }), 1)).toThrow(ApplicationError);
  });
});
