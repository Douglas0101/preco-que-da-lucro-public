import { describe, expect, it, vi } from "vitest";
import type { Product } from "@/db/schema";
import type { RequestContext } from "@/lib/request-context";
import {
  dashboardService,
  DefaultDashboardService,
  getDashboardSummary,
  periodStart,
  type DashboardSummary,
} from "@/server/services/dashboard.service";
import {
  dashboardRepository,
  loadDashboardInputs,
  type DashboardInputs,
  type DashboardRepository,
} from "@/server/repositories/dashboard.repository";
import type { SalesService } from "@/server/services/sales.service";
import type { SalesSummary } from "@/server/repositories/sales.repository";
import { contextWithRole } from "./helpers/request-context";

const TENANT_ID = "50000000-0000-4000-8000-000000000005";

class FakeDashboardRepository implements DashboardRepository {
  readonly contexts: RequestContext[] = [];

  constructor(private readonly result: DashboardInputs) {}

  async loadInputs(context: RequestContext): Promise<DashboardInputs> {
    this.contexts.push(context);
    return this.result;
  }
}

class FakeSalesService implements SalesService {
  readonly calls: Array<{ context: RequestContext; from: Date }> = [];

  constructor(private readonly summary: SalesSummary = { revenue: "0.0000", count: 0 }) {}

  async create(): Promise<never> {
    throw new Error("NOT_IMPLEMENTED");
  }

  async revenue(): Promise<string> {
    return "0.0000";
  }

  async summaryForPeriod(context: RequestContext, from: Date): Promise<SalesSummary> {
    this.calls.push({ context, from });
    return this.summary;
  }

  async list(): Promise<never> {
    throw new Error("NOT_IMPLEMENTED");
  }
}

function product(overrides: Partial<Product> = {}): Product {
  return {
    id: "70000000-0000-4000-8000-000000000001",
    tenantId: TENANT_ID,
    userId: "user-1",
    name: "Bolo de Cacau",
    status: "active",
    currentPrice: null,
    yieldQty: null,
    yieldUnit: null,
    taxRegime: null,
    taxRate: null,
    isDemo: false,
    notes: null,
    version: 0,
    archivedAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

function inputs(overrides: Partial<DashboardInputs> = {}): DashboardInputs {
  return {
    productRows: [],
    expenseRows: [],
    ingredientRows: [],
    packagingRows: [],
    feeRows: [],
    marketRows: [],
    ...overrides,
  };
}

describe("DefaultDashboardService (DI)", () => {
  it("carrega os inputs pelo repository injetado e consulta sales no início do período", async () => {
    const context = contextWithRole("owner");
    const repository = new FakeDashboardRepository(inputs());
    const sales = new FakeSalesService({ revenue: "150.0000", count: 3 });
    const service = new DefaultDashboardService(repository, sales);

    const summary = await service.getSummary(context, "quarter");

    expect(repository.contexts).toEqual([context]);
    expect(sales.calls).toHaveLength(1);
    expect(sales.calls[0]!.context).toBe(context);
    expect(sales.calls[0]!.from).toEqual(periodStart("quarter"));
    expect(summary).toEqual({
      productCount: 0,
      fixedExpenses: "0.0000",
      bestProduct: null,
      hasInvalidCalculation: false,
      incompleteProductCount: 0,
      alerts: [],
      period: "quarter",
      sales: { revenue: "150.0000", count: 3 },
    });
  });

  it("marca cálculo inválido sem eleger destaque", async () => {
    const repository = new FakeDashboardRepository(
      inputs({ productRows: [product({ currentPrice: "-1" })] }),
    );
    const service = new DefaultDashboardService(repository, new FakeSalesService());

    const summary = await service.getSummary(contextWithRole("owner"));

    expect(summary.productCount).toBe(1);
    expect(summary.hasInvalidCalculation).toBe(true);
    expect(summary.bestProduct).toBeNull();
  });

  it("conta produtos incompletos e alerta antes dos destaques", async () => {
    const repository = new FakeDashboardRepository(
      inputs({ productRows: [product({ status: "draft" })] }),
    );
    const service = new DefaultDashboardService(repository, new FakeSalesService());

    const summary = await service.getSummary(contextWithRole("owner"));

    expect(summary.incompleteProductCount).toBe(1);
    expect(summary.alerts[0]).toContain("não participa(m) dos destaques");
    expect(summary.hasInvalidCalculation).toBe(false);
  });

  it("projeta o melhor produto a partir dos inputs injetados", async () => {
    const okProduct = product({
      name: "Bolo de Cacau",
      currentPrice: "25",
      yieldQty: "1",
      taxRate: "0.1",
    });
    const repository = new FakeDashboardRepository(
      inputs({
        productRows: [okProduct],
        ingredientRows: [
          {
            id: "ingredient-1",
            tenantId: TENANT_ID,
            userId: "user-1",
            productId: okProduct.id,
            usedQty: "1",
            usedUnit: "kg",
            packagePrice: "10",
            packageQty: "1",
            packageUnit: "kg",
            conversionFactor: null,
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          } as DashboardInputs["ingredientRows"][number],
        ],
        packagingRows: [
          {
            id: "packaging-1",
            tenantId: TENANT_ID,
            userId: "user-1",
            productId: okProduct.id,
            packagePrice: "1",
            unitsPerPackage: "1",
            createdAt: new Date("2026-01-01T00:00:00.000Z"),
            updatedAt: new Date("2026-01-01T00:00:00.000Z"),
          } as DashboardInputs["packagingRows"][number],
        ],
      }),
    );
    const service = new DefaultDashboardService(repository, new FakeSalesService());

    const summary = await service.getSummary(contextWithRole("owner"));

    expect(summary.hasInvalidCalculation).toBe(false);
    expect(summary.bestProduct).toEqual({ name: "Bolo de Cacau", cmPct: "46.000000" });
    expect(summary.alerts).toEqual([]);
  });
});

describe("dashboard adapters", () => {
  it("getDashboardSummary delega para o singleton com o período recebido", async () => {
    const context = contextWithRole("owner");
    const expected: DashboardSummary = {
      productCount: 0,
      fixedExpenses: null,
      bestProduct: null,
      hasInvalidCalculation: false,
      incompleteProductCount: 0,
      alerts: [],
      period: "year",
      sales: { revenue: "0.0000", count: 0 },
    };
    const spy = vi.spyOn(dashboardService, "getSummary").mockResolvedValue(expected);
    try {
      await expect(getDashboardSummary(context, "year")).resolves.toEqual(expected);
      expect(spy).toHaveBeenCalledWith(context, "year");
    } finally {
      spy.mockRestore();
    }
  });

  it("loadDashboardInputs delega para o repositório singleton", async () => {
    const context = contextWithRole("owner");
    const expected = inputs();
    const spy = vi.spyOn(dashboardRepository, "loadInputs").mockResolvedValue(expected);
    try {
      await expect(loadDashboardInputs(context)).resolves.toBe(expected);
      expect(spy).toHaveBeenCalledWith(context);
    } finally {
      spy.mockRestore();
    }
  });
});
