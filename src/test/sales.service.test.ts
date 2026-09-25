import { describe, expect, it } from "vitest";
import type { Sale, SaleItem } from "@/db/schema";
import type { RequestContext } from "@/lib/request-context";
import { DefaultSalesService, type SaleDraft } from "@/server/services/sales.service";
import type { SaleWrite, SalesRepository } from "@/server/repositories/sales.repository";
import { contextWithRole } from "./helpers/request-context";

class FakeSalesRepository implements SalesRepository {
  lastWrite: SaleWrite | undefined;

  async create(_context: RequestContext, input: SaleWrite) {
    this.lastWrite = input;
    return { sale: {} as Sale, items: [] as SaleItem[] };
  }

  async revenue(): Promise<string> {
    return "0.0000";
  }

  async summaryForPeriod() {
    return { revenue: "0.0000", count: 0 };
  }

  async list() {
    return [];
  }
}

describe("SalesService", () => {
  it("calcula linhas e faturamento bruto com decimal canônico", async () => {
    const repository = new FakeSalesRepository();
    const service = new DefaultSalesService(repository);
    const input: SaleDraft = {
      occurredAt: new Date("2026-08-15T12:00:00.000Z"),
      channel: "manual",
      items: [
        { productId: "50000000-0000-4000-8000-000000000005", quantity: "2", unitPrice: "10" },
      ],
    };

    await service.create(contextWithRole("owner"), input);

    expect(repository.lastWrite).toMatchObject({
      grossAmount: "20.0000",
      netAmount: "20.0000",
      items: [
        {
          quantity: "2.000000",
          unitPrice: "10.0000",
          totalAmount: "20.0000",
        },
      ],
    });
  });

  it("rejeita venda sem itens antes de tocar o repository", async () => {
    const repository = new FakeSalesRepository();
    const service = new DefaultSalesService(repository);

    await expect(
      service.create(contextWithRole("owner"), {
        occurredAt: new Date(),
        channel: "manual",
        items: [],
      }),
    ).rejects.toThrow("SALE_REQUIRES_ITEM");
    expect(repository.lastWrite).toBeUndefined();
  });

  it("mantém autorização de escrita no service", async () => {
    const service = new DefaultSalesService(new FakeSalesRepository());

    await expect(
      service.create(contextWithRole("member"), {
        occurredAt: new Date(),
        channel: "manual",
        items: [
          { productId: "50000000-0000-4000-8000-000000000005", quantity: "1", unitPrice: "1" },
        ],
      }),
    ).rejects.toThrow("Você não pode realizar esta ação.");
  });

  it("soma o bruto a partir das linhas já arredondadas e limita o líquido", async () => {
    const repository = new FakeSalesRepository();
    const service = new DefaultSalesService(repository);

    await service.create(contextWithRole("owner"), {
      occurredAt: new Date("2026-08-15T12:00:00.000Z"),
      channel: " manual ",
      items: [
        {
          productId: "50000000-0000-4000-8000-000000000005",
          quantity: "3",
          unitPrice: "0.33335",
        },
        {
          productId: "50000000-0000-4000-8000-000000000005",
          quantity: "1",
          unitPrice: "0.33335",
        },
      ],
    });

    expect(repository.lastWrite).toMatchObject({
      channel: "manual",
      grossAmount: "1.3336",
      items: [
        { unitPrice: "0.3334", totalAmount: "1.0002" },
        { unitPrice: "0.3334", totalAmount: "0.3334" },
      ],
    });
    await expect(
      service.create(contextWithRole("owner"), {
        occurredAt: new Date(),
        channel: "manual",
        netAmount: "1.3335",
        items: [
          { productId: "50000000-0000-4000-8000-000000000005", quantity: "1", unitPrice: "1" },
        ],
      }),
    ).rejects.toThrow("INVALID_SALE_NET_AMOUNT");
  });

  it("rejeita data e canal fora do contrato", async () => {
    const service = new DefaultSalesService(new FakeSalesRepository());
    const draft = {
      occurredAt: new Date("invalid"),
      channel: "manual",
      items: [{ productId: "50000000-0000-4000-8000-000000000005", quantity: "1", unitPrice: "1" }],
    };
    await expect(service.create(contextWithRole("owner"), draft)).rejects.toThrow(
      "INVALID_SALE_DATE",
    );
    await expect(
      service.create(contextWithRole("owner"), { ...draft, occurredAt: new Date(), channel: " " }),
    ).rejects.toThrow("INVALID_SALE_CHANNEL");
  });
});
