import { desc, eq, and, isNull } from "drizzle-orm";
import type { DatabaseTransaction } from "@/db/client.server";
import { calculationSnapshots, type CalculationSnapshot } from "@/db/schema";
import type { RequestContext } from "@/lib/request-context";

export interface CalculationSnapshotWrite {
  entityType: string;
  entityId: string | null;
  calculationType: string;
  idempotencyKey: string;
  inputs: Record<string, unknown>;
  outputs: Record<string, unknown>;
  engineVersion: string;
}

export interface CalculationSnapshotRepository {
  append(context: RequestContext, input: CalculationSnapshotWrite): Promise<CalculationSnapshot>;
  listForEntity(
    context: RequestContext,
    entityType: string,
    entityId: string | null,
  ): Promise<CalculationSnapshot[]>;
}

export class DrizzleCalculationSnapshotRepository implements CalculationSnapshotRepository {
  async append(context: RequestContext, input: CalculationSnapshotWrite) {
    // §9.2 — o adapter estreita o handle neutro do contexto para a transação do
    // driver; o contrato (`RequestContext`) segue driver-agnostic.
    const tx = context.transaction as DatabaseTransaction;
    const [row] = await tx
      .insert(calculationSnapshots)
      .values({
        tenantId: context.tenantId,
        userId: context.userId,
        entityType: input.entityType,
        entityId: input.entityId ?? null,
        calculationType: input.calculationType,
        idempotencyKey: input.idempotencyKey,
        inputs: input.inputs,
        outputs: input.outputs,
        engineVersion: input.engineVersion,
      })
      .onConflictDoNothing()
      .returning();
    if (row) return row;
    // Replay idempotente: a única violação possível é o UNIQUE
    // (tenant_id, calculation_type, idempotency_key) — devolve o registro existente.
    const [existing] = await tx
      .select()
      .from(calculationSnapshots)
      .where(
        and(
          eq(calculationSnapshots.tenantId, context.tenantId),
          eq(calculationSnapshots.calculationType, input.calculationType),
          eq(calculationSnapshots.idempotencyKey, input.idempotencyKey),
        ),
      )
      .limit(1);
    if (!existing) throw new Error("DATABASE_ERROR");
    return existing;
  }

  listForEntity(context: RequestContext, entityType: string, entityId: string | null) {
    const predicates = [
      eq(calculationSnapshots.tenantId, context.tenantId),
      eq(calculationSnapshots.entityType, entityType),
    ];
    if (entityId === null) {
      predicates.push(isNull(calculationSnapshots.entityId));
    } else {
      predicates.push(eq(calculationSnapshots.entityId, entityId));
    }
    return (context.transaction as DatabaseTransaction)
      .select()
      .from(calculationSnapshots)
      .where(and(...predicates))
      .orderBy(desc(calculationSnapshots.createdAt));
  }
}

export const calculationSnapshotRepository = new DrizzleCalculationSnapshotRepository();
