import { createHash } from "node:crypto";
import { assertTenantMutationAuthorized, type RequestContext } from "@/lib/request-context";
import {
  calculationSnapshotRepository,
  type CalculationSnapshotRepository,
  type CalculationSnapshotWrite,
} from "@/server/repositories/calculation-snapshot.repository";
import type { CalculationSnapshot } from "@/db/schema";

/** Token that stands for "this calculation type has no entity" (e.g. ad-hoc
 * break-even scenarios). Documented in docs/evidence/
 * s3-snapshot-idempotency-2026-09-01.md and encoded in every derived key. */
export const NO_ENTITY_TOKEN = "no-entity";

function normalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(normalizeValue);
  if (value !== null && typeof value === "object") {
    const sorted = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return Object.fromEntries(sorted.map(([key, inner]) => [key, normalizeValue(inner)]));
  }
  return value;
}

/**
 * WS-03 / plan §10.6 + §22: single source of truth for snapshot idempotency
 * keys. The key hashes [calculationType, entityType, entityId ?? "no-entity",
 * engineVersion, normalizedInputs] over a canonical JSON encoding (object keys
 * recursively sorted) so that equal payloads hash equal regardless of property
 * insertion order. Because the entity is encoded in the key itself, the UNIQUE
 * (tenant_id, calculation_type, idempotency_key) index — which intentionally
 * omits entity_id — can never collapse two distinct entities that share an
 * identical payload: their keys differ. Replays of the same calculation for
 * the same entity converge on the same key and dedup idempotently.
 */
export function deriveSnapshotIdempotencyKey(input: {
  calculationType: string;
  entityType: string;
  entityId: string | null;
  engineVersion: string;
  inputs: Record<string, unknown>;
}): string {
  const canonical = JSON.stringify([
    input.calculationType,
    input.entityType,
    input.entityId ?? NO_ENTITY_TOKEN,
    input.engineVersion,
    normalizeValue(input.inputs),
  ]);
  return createHash("sha256").update(canonical).digest("hex");
}

export interface CalculationSnapshotService {
  append(context: RequestContext, input: CalculationSnapshotWrite): Promise<CalculationSnapshot>;
  listForEntity(
    context: RequestContext,
    entityType: string,
    entityId: string | null,
  ): Promise<CalculationSnapshot[]>;
}

export class DefaultCalculationSnapshotService implements CalculationSnapshotService {
  constructor(private readonly repository: CalculationSnapshotRepository) {}

  async append(context: RequestContext, input: CalculationSnapshotWrite) {
    assertTenantMutationAuthorized(context);
    return this.repository.append(context, input);
  }

  listForEntity(context: RequestContext, entityType: string, entityId: string | null) {
    return this.repository.listForEntity(context, entityType, entityId);
  }
}

export const calculationSnapshotService: CalculationSnapshotService =
  new DefaultCalculationSnapshotService(calculationSnapshotRepository);
