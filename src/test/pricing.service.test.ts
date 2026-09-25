import { describe, expect, it } from "vitest";
import type { CalculationSnapshot } from "@/db/schema";
import { calculatePriceFormation, type PriceFormationInput } from "@/lib/finance";
import type { RequestContext } from "@/lib/request-context";
import type { CalculationSnapshotWrite } from "@/server/repositories/calculation-snapshot.repository";
import {
  deriveSnapshotIdempotencyKey,
  type CalculationSnapshotService,
} from "@/server/services/calculation-snapshot.service";
import { FINANCE_ENGINE_VERSION } from "@/server/services/financial.service";
import { DefaultPricingService } from "@/server/services/pricing.service";
import { contextWithRole } from "./helpers/request-context";

const PRODUCT_ID = "70000000-0000-4000-8000-000000000001";

class FakeCalculationSnapshotService implements CalculationSnapshotService {
  readonly writes: CalculationSnapshotWrite[] = [];

  constructor(private readonly fail = false) {}

  async append(
    _context: RequestContext,
    input: CalculationSnapshotWrite,
  ): Promise<CalculationSnapshot> {
    if (this.fail) throw new Error("SNAPSHOT_DOWN");
    this.writes.push(input);
    return { id: `snapshot-${this.writes.length}` } as CalculationSnapshot;
  }

  async listForEntity(): Promise<CalculationSnapshot[]> {
    return [];
  }
}

function formationInput(overrides: Partial<PriceFormationInput> = {}): PriceFormationInput {
  return {
    directUnitCost: 11,
    nonPercentageVariableUnitCost: 2,
    taxRate: 10,
    fees: [{ percentage: 5 }],
    targetContributionRate: 30,
    marketReference: 30,
    ...overrides,
  };
}

function snapshotInput(priceFormation = calculatePriceFormation(formationInput())) {
  return {
    productId: PRODUCT_ID,
    nonPercentageVariableUnitCost: 2,
    targetContributionRate: 30,
    marketAvgPrice: 30,
    priceFormation,
  };
}

describe("DefaultPricingService", () => {
  it("delega a formação de preço para o motor canônico sem mudar o output", () => {
    const service = new DefaultPricingService(new FakeCalculationSnapshotService());
    const input = formationInput();

    expect(service.calculatePriceFormationFor(input)).toEqual(calculatePriceFormation(input));
  });

  it("grava o snapshot de pricing com entidade, inputs e chave idempotente derivada", async () => {
    const snapshots = new FakeCalculationSnapshotService();
    const service = new DefaultPricingService(snapshots);
    const input = snapshotInput();

    await service.appendPricingSnapshot(contextWithRole("owner"), input);

    expect(snapshots.writes).toHaveLength(1);
    const write = snapshots.writes[0]!;
    expect(write).toMatchObject({
      entityType: "product",
      entityId: PRODUCT_ID,
      calculationType: "pricing",
      engineVersion: FINANCE_ENGINE_VERSION,
      inputs: {
        productId: PRODUCT_ID,
        nonPercentageVariableUnitCost: 2,
        targetContributionRate: 30,
        marketAvgPrice: 30,
      },
      outputs: JSON.parse(JSON.stringify({ priceFormation: input.priceFormation })),
    });
    expect(write.idempotencyKey).toBe(
      deriveSnapshotIdempotencyKey({
        calculationType: "pricing",
        entityType: "product",
        entityId: PRODUCT_ID,
        engineVersion: FINANCE_ENGINE_VERSION,
        inputs: {
          productId: PRODUCT_ID,
          nonPercentageVariableUnitCost: 2,
          targetContributionRate: 30,
          marketAvgPrice: 30,
        },
      }),
    );
  });

  it("converge na mesma chave idempotente no replay da mesma análise", async () => {
    const snapshots = new FakeCalculationSnapshotService();
    const service = new DefaultPricingService(snapshots);
    const context = contextWithRole("owner");
    const input = snapshotInput();

    await service.appendPricingSnapshot(context, input);
    await service.appendPricingSnapshot(context, input);

    expect(snapshots.writes).toHaveLength(2);
    expect(snapshots.writes[0]!.idempotencyKey).toBe(snapshots.writes[1]!.idempotencyKey);
  });

  it("engole falha do snapshot mantendo o output do diagnóstico intacto", async () => {
    const service = new DefaultPricingService(new FakeCalculationSnapshotService(true));

    await expect(
      service.appendPricingSnapshot(contextWithRole("owner"), snapshotInput()),
    ).resolves.toBeUndefined();
  });
});
