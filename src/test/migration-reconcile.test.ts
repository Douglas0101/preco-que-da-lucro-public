import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("reconciliação de migração", () => {
  it("inclui o conteúdo amostrado, não somente os UUIDs", () => {
    const source = readFileSync(resolve(process.cwd(), "scripts/migration/reconcile.ts"), "utf8");
    expect(source).toContain("to_jsonb(sample)::text");
    expect(source).toContain("select * from ${safeRelation}");
  });
});
