import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createProductInput, updateProductInput } from "@/lib/products.functions";
import { createExpenseInput, updateExpenseInput } from "@/lib/expenses.functions";

vi.mock("@tanstack/react-start", () => ({
  createMiddleware: () => ({ server: (handler: unknown) => handler }),
  createServerFn: () => {
    const builder = {
      middleware: () => builder,
      validator: () => builder,
      handler: (handler: unknown) => handler,
    };
    return builder;
  },
}));

const PRODUCT_ID = "50000000-0000-4000-8000-000000000005";
const EXPENSE_ID = "50000000-0000-4000-8000-00000000000e";

async function source(path: string): Promise<string> {
  return readFile(resolve(process.cwd(), path), "utf8");
}

describe("BFF create/update split — contrato estático (M02-D-010)", () => {
  it("products.functions.ts expõe createProduct/updateProduct e mantém upsert/delete legados", async () => {
    const text = await source("src/lib/products.functions.ts");
    expect(text).toMatch(/export const createProduct\s*=/);
    expect(text).toMatch(/export const updateProduct\s*=/);
    expect(text).toMatch(/export const upsertProduct\s*=/);
    expect(text).toMatch(/export const deleteProduct\s*=\s*archiveProduct/);
    expect(text).toContain("deleteProduct = archiveProduct");
  });

  it("expenses.functions.ts expõe createExpense/updateExpense e mantém upsert legado", async () => {
    const text = await source("src/lib/expenses.functions.ts");
    expect(text).toMatch(/export const createExpense\s*=/);
    expect(text).toMatch(/export const updateExpense\s*=/);
    expect(text).toMatch(/export const upsertExpense\s*=/);
  });

  it("createProductInput não aceita id/version; updateProductInput exige ambos", () => {
    expect(Object.hasOwn(createProductInput.shape, "id")).toBe(false);
    expect(Object.hasOwn(createProductInput.shape, "version")).toBe(false);
    expect(createProductInput.safeParse({ name: "Bolo" }).success).toBe(true);

    expect(updateProductInput.safeParse({ name: "Bolo" }).success).toBe(false);
    expect(updateProductInput.safeParse({ id: PRODUCT_ID, name: "Bolo" }).success).toBe(false);
    expect(updateProductInput.safeParse({ id: PRODUCT_ID, name: "Bolo", version: 2 }).success).toBe(
      true,
    );
    expect(
      updateProductInput.safeParse({ id: PRODUCT_ID, name: "Bolo", version: -1 }).success,
    ).toBe(false);
  });

  it("createExpenseInput não aceita id/version; updateExpenseInput exige ambos", () => {
    expect(Object.hasOwn(createExpenseInput.shape, "id")).toBe(false);
    expect(Object.hasOwn(createExpenseInput.shape, "version")).toBe(false);
    expect(createExpenseInput.safeParse({ name: "Luz", amount: "10", type: "fixa" }).success).toBe(
      true,
    );

    expect(updateExpenseInput.safeParse({ name: "Luz", amount: "10", type: "fixa" }).success).toBe(
      false,
    );
    expect(
      updateExpenseInput.safeParse({
        id: EXPENSE_ID,
        name: "Luz",
        amount: "10",
        type: "fixa",
      }).success,
    ).toBe(false);
    expect(
      updateExpenseInput.safeParse({
        id: EXPENSE_ID,
        name: "Luz",
        amount: "10",
        type: "fixa",
        version: 1,
      }).success,
    ).toBe(true);
  });
});
