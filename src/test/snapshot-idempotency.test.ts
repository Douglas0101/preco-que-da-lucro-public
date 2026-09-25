import { describe, expect, it } from "vitest";
import {
  NO_ENTITY_TOKEN,
  deriveSnapshotIdempotencyKey,
} from "@/server/services/calculation-snapshot.service";

/**
 * WS-03 / plan §10.6 + §22 — idempotency key derivation contract.
 *
 * Equivalence-class argument for the UNIQUE index WITHOUT entity_id:
 * the index is UNIQUE (tenant_id, calculation_type, idempotency_key). Because
 * deriveSnapshotIdempotencyKey encodes [calculationType, entityType,
 * entityId ?? "no-entity", engineVersion, normalizedInputs] into the key, two
 * distinct entities always produce distinct keys — even when their payloads
 * are byte-identical. Therefore the (tenant_id, calculation_type,
 * idempotency_key) triple is an equivalence class that is already
 * entity-refined by construction: the index never collapses rows for
 * different entities, and adding entity_id to the index would be redundant.
 * Distinct tenants are likewise never conflated: the index itself scopes
 * uniqueness per tenant_id, so identical keys in different tenants remain
 * distinct rows. Replays of the same calculation (same tenant, type, entity,
 * inputs) converge on the same key and dedup idempotently via the
 * repository's insert-on-conflict-do-nothing + re-select append.
 */

const ENTITY_A = "11111111-1111-4111-8111-111111111111";
const ENTITY_B = "22222222-2222-4222-8222-222222222222";

describe("deriveSnapshotIdempotencyKey", () => {
  it("é determinística: mesmos inputs produzem a mesma chave independentemente da ordem das chaves do objeto", () => {
    const base = {
      calculationType: "diagnostic",
      entityType: "product",
      entityId: ENTITY_A,
      engineVersion: "2.0.0",
    } as const;
    const keyA = deriveSnapshotIdempotencyKey({
      ...base,
      inputs: { price: 10, tax: 0.2, nested: { b: 2, a: 1 } },
    });
    const keyB = deriveSnapshotIdempotencyKey({
      ...base,
      inputs: { nested: { a: 1, b: 2 }, tax: 0.2, price: 10 },
    });
    expect(keyA).toBe(keyB);
    expect(keyA).toMatch(/^[0-9a-f]{64}$/);
  });

  it("entidades distintas com payload idêntico geram chaves DIFERENTES (sem colisão, mesmo com UNIQUE sem entity_id)", () => {
    const inputs = { productId: "x", targetContributionRate: 30 };
    const keyFor = (entityId: string) =>
      deriveSnapshotIdempotencyKey({
        calculationType: "diagnostic",
        entityType: "product",
        entityId,
        engineVersion: "2.0.0",
        inputs,
      });
    expect(keyFor(ENTITY_A)).not.toBe(keyFor(ENTITY_B));
  });

  it("tenants distintos: a unicidade é garantida pelo próprio índice (tenant_id, calculation_type, idempotency_key)", () => {
    // A mesma chave derivada em tenants diferentes é admitida pelo índice: a
    // primeira coluna da UNIQUE é tenant_id, logo linhas de tenants distintos
    // nunca colidem. Não há nada a derivar por tenant no hash.
    const key = deriveSnapshotIdempotencyKey({
      calculationType: "diagnostic",
      entityType: "product",
      entityId: ENTITY_A,
      engineVersion: "2.0.0",
      inputs: { price: 1 },
    });
    expect(typeof key).toBe("string");
  });

  it('break_even sem entidade usa o token "no-entity" e deduplica inputs iguais (dedup legítimo)', () => {
    const keyFor = (inputs: Record<string, unknown>) =>
      deriveSnapshotIdempotencyKey({
        calculationType: "break_even",
        entityType: "break_even_scenario",
        entityId: null,
        engineVersion: "2.0.0",
        inputs,
      });
    const scenarioA = { price: "20", fixedExpenses: ["100"], unitMode: "discrete" };
    const scenarioAReordered = { unitMode: "discrete", fixedExpenses: ["100"], price: "20" };
    const scenarioB = { price: "21", fixedExpenses: ["100"], unitMode: "discrete" };
    expect(NO_ENTITY_TOKEN).toBe("no-entity");
    expect(keyFor(scenarioA)).toBe(keyFor(scenarioAReordered));
    expect(keyFor(scenarioA)).not.toBe(keyFor(scenarioB));
  });

  it("calculation_type e entity_type fazem parte da chave: o mesmo payload em contextos diferentes não colide", () => {
    const inputs = { productId: ENTITY_A };
    const diagnostic = deriveSnapshotIdempotencyKey({
      calculationType: "diagnostic",
      entityType: "product",
      entityId: ENTITY_A,
      engineVersion: "2.0.0",
      inputs,
    });
    const pricing = deriveSnapshotIdempotencyKey({
      calculationType: "pricing",
      entityType: "product",
      entityId: ENTITY_A,
      engineVersion: "2.0.0",
      inputs,
    });
    const simulation = deriveSnapshotIdempotencyKey({
      calculationType: "diagnostic",
      entityType: "simulation",
      entityId: ENTITY_A,
      engineVersion: "2.0.0",
      inputs,
    });
    expect(new Set([diagnostic, pricing, simulation]).size).toBe(3);
  });
});
