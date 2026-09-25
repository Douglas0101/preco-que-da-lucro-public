import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  classifyProject,
  computeSha256,
  listMigrationFiles,
  loadJournal,
  verifyMigrationClasses,
} from "../../scripts/db/check-migration-classes";
import { migrationClasses, type MigrationClassEntry } from "../../scripts/db/migration-classes";

const root = process.cwd();

async function realInputs() {
  const journal = await loadJournal(root);
  const migrationFiles = await listMigrationFiles(root);
  const hashes = new Map<string, string>();
  for (const file of migrationFiles) {
    hashes.set(file, computeSha256(await readFile(resolve(root, "drizzle", file))));
  }
  return { journalEntries: journal.entries, migrationFiles, hashes };
}

describe("classificação de migrations (§27a)", () => {
  it("mantém a bijeção journal ↔ registry ↔ drizzle/*.sql com hash byte a byte", async () => {
    const journal = await loadJournal(root);
    const result = await classifyProject(root);
    expect(result.errors).toEqual([]);
    expect(result.total).toBe(journal.entries.length);
    expect(result.classified).toBe(result.total);
    expect(migrationClasses).toHaveLength(journal.entries.length);
  });

  it("falha quando o sha256 do registry é adulterado", async () => {
    const { journalEntries, migrationFiles, hashes } = await realInputs();
    const tampered = migrationClasses.map((entry) =>
      entry.tag === "0004_giant_nocturne" ? { ...entry, sha256: "0".repeat(64) } : entry,
    );
    const { errors } = verifyMigrationClasses({
      journalEntries,
      migrationFiles,
      registry: tampered,
      hashes,
    });
    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain("0004_giant_nocturne");
    expect(errors[0]).toContain("sha256 divergente");
  });

  it("exige idempotent+rollback em DATA_MIGRATION e contractOf em BREAKING", async () => {
    const { journalEntries, migrationFiles, hashes } = await realInputs();
    const tampered: MigrationClassEntry[] = migrationClasses.map((entry) => {
      if (entry.tag === "0010_backfill_accounts_issuer") return { ...entry, idempotent: false };
      if (entry.tag === "0009_military_gertrude_yorkes") return { ...entry, class: "BREAKING" };
      return entry;
    });
    const { errors } = verifyMigrationClasses({
      journalEntries,
      migrationFiles,
      registry: tampered,
      hashes,
    });
    const joined = errors.join("\n");
    expect(joined).toContain("DATA_MIGRATION 0010_backfill_accounts_issuer exige idempotent: true");
    expect(joined).toContain("BREAKING 0009_military_gertrude_yorkes exige contractOf");
  });
});
