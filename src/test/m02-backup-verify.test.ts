import { describe, expect, it } from "vitest";
import { compareInventories, sha256, type Inventory } from "../../scripts/db/backup-verify";
const baseline: Inventory = {
  measured_at: "2026-09-05",
  version: "170011",
  tables: { "public.accounts": { count: 1, checksum: "hash-a" } },
  journal: [{ hash: "migration", created_at: "1" }],
  catalog: [{ grant: "SELECT" }],
  roles: [{ rolname: "app_runtime", rolbypassrls: false }],
};
describe("backup evidence comparison", () => {
  it("hashes bytes without Latin-1 to UTF-8 re-encoding", () => {
    expect(sha256(Buffer.from([255]))).toBe(
      "a8100ae6aa1940d0b663bb31cd466142ebbdbd5187131b92d93818987832eb89",
    );
  });
  it("rejects changed rows with equal counts", () => {
    expect(
      compareInventories(baseline, {
        ...baseline,
        tables: { "public.accounts": { count: 1, checksum: "hash-b" } },
      }).pass,
    ).toBe(false);
  });
  it("rejects extra or missing tables", () => {
    expect(compareInventories(baseline, { ...baseline, tables: {} }).pass).toBe(false);
  });
  it.each(["journal", "catalog", "roles"] as const)("rejects divergent %s", (key) => {
    expect(compareInventories(baseline, { ...baseline, [key]: [] }).pass).toBe(false);
  });
  it("accepts identical content but not a PostgreSQL major mismatch", () => {
    expect(compareInventories(baseline, { ...baseline, measured_at: "later" }).pass).toBe(true);
    expect(compareInventories(baseline, { ...baseline, version: "180000" }).pass).toBe(false);
  });
});
