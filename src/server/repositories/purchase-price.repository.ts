import { and, desc, eq, sql } from "drizzle-orm";
import type { DatabaseTransaction } from "@/db/client.server";
import { purchasePriceHistory, type PurchasePriceHistory } from "@/db/schema";
import type { RequestContext } from "@/lib/request-context";

export type PurchasePriceKind = "ingredient" | "packaging";

export interface PurchasePriceHistoryWrite {
  kind: PurchasePriceKind;
  subjectId: string;
  price: string;
  quantity: string;
  unit: string;
  validFrom: Date;
  supplierId?: string | null;
}

export interface PurchasePriceRepository {
  append(context: RequestContext, input: PurchasePriceHistoryWrite): Promise<PurchasePriceHistory>;
  /**
   * Serializa read-modify-write por tenant/kind/subject. O serviço adquire o
   * lock ANTES do UPDATE da linha base; o append reentra no mesmo lock
   * (advisory xact locks são reentrantes por sessão).
   */
  lock(
    context: RequestContext,
    input: Pick<PurchasePriceHistoryWrite, "kind" | "subjectId">,
  ): Promise<void>;
}

function sameEffectiveValue(
  row: PurchasePriceHistory | undefined,
  input: PurchasePriceHistoryWrite,
): boolean {
  return (
    row?.price === input.price &&
    row.quantity === input.quantity &&
    row.unit === input.unit &&
    (row.supplierId ?? null) === (input.supplierId ?? null)
  );
}

export class DrizzlePurchasePriceRepository implements PurchasePriceRepository {
  async lock(
    context: RequestContext,
    input: Pick<PurchasePriceHistoryWrite, "kind" | "subjectId">,
  ): Promise<void> {
    const lockKey = `${context.tenantId}:${input.kind}:${input.subjectId}`;
    // §9.2 — o adapter estreita o handle neutro do contexto para a transação do
    // driver; o contrato (`RequestContext`) segue driver-agnostic.
    const tx = context.transaction as DatabaseTransaction;
    await tx.execute(sql`
      select pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
    `);
  }

  async append(context: RequestContext, input: PurchasePriceHistoryWrite) {
    await this.lock(context, input);
    const tx = context.transaction as DatabaseTransaction;

    const targetPredicate =
      input.kind === "ingredient"
        ? and(
            eq(purchasePriceHistory.tenantId, context.tenantId),
            eq(purchasePriceHistory.ingredientId, input.subjectId),
          )
        : and(
            eq(purchasePriceHistory.tenantId, context.tenantId),
            eq(purchasePriceHistory.packagingId, input.subjectId),
          );
    const latestRows = await tx
      .select()
      .from(purchasePriceHistory)
      .where(targetPredicate)
      .orderBy(desc(purchasePriceHistory.validFrom), desc(purchasePriceHistory.recordedAt))
      .limit(1);
    const latest = latestRows[0];
    if (sameEffectiveValue(latest, input)) return latest;

    const [row] = await tx
      .insert(purchasePriceHistory)
      .values({
        tenantId: context.tenantId,
        userId: context.userId,
        subjectType: input.kind,
        subjectId: input.subjectId,
        ingredientId: input.kind === "ingredient" ? input.subjectId : null,
        packagingId: input.kind === "packaging" ? input.subjectId : null,
        price: input.price,
        quantity: input.quantity,
        unit: input.unit,
        supplierId: input.supplierId ?? null,
        validFrom: input.validFrom,
      })
      .returning();
    if (!row) throw new Error("DATABASE_ERROR");
    return row;
  }
}

export const purchasePriceRepository: PurchasePriceRepository =
  new DrizzlePurchasePriceRepository();
