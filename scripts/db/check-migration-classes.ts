/**
 * Checker do registry de classificação de migrations (§27a).
 *
 * Exige bijeção entre `drizzle/meta/_journal.json`, `scripts/db/migration-classes.ts`
 * e os arquivos `drizzle/*.sql`; recalcula o sha256 byte a byte (mesmo hash do
 * runtime do Drizzle) e valida as regras por classe:
 *   - DATA_MIGRATION exige `idempotent: true` e `rollback` preenchido;
 *   - BREAKING exige `contractOf` apontando para a migration expand.
 *
 * Uso: `npx tsx scripts/db/check-migration-classes.ts [--write]`
 * `--write` grava `docs/evidence/migration-classification-<data>.md`.
 */

import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  MIGRATION_CLASSES,
  migrationClasses,
  type AppliedOn,
  type MigrationClass,
  type MigrationClassEntry,
} from "./migration-classes";

export interface JournalEntry {
  idx: number;
  version: string;
  when: number;
  tag: string;
  breakpoints: boolean;
}

export interface MigrationJournal {
  version: string;
  dialect: string;
  entries: JournalEntry[];
}

export interface VerifiedMigration {
  idx: number;
  tag: string;
  class: MigrationClass;
  appliedOn: AppliedOn;
  sha256: string;
  rollback: string;
  ok: boolean;
}

export interface ClassifyResult {
  total: number;
  classified: number;
  rows: VerifiedMigration[];
  errors: string[];
}

export interface VerifyInput {
  journalEntries: readonly JournalEntry[];
  /** Basenames de `drizzle/*.sql`, por exemplo `0000_p0_postgres_foundation.sql`. */
  migrationFiles: readonly string[];
  registry: readonly MigrationClassEntry[];
  /** Basename do SQL → sha256 do conteúdo integral. */
  hashes: ReadonlyMap<string, string>;
}

export function computeSha256(content: Buffer | string): string {
  return createHash("sha256").update(content).digest("hex");
}

export async function loadJournal(root: string): Promise<MigrationJournal> {
  const raw = await readFile(resolve(root, "drizzle/meta/_journal.json"), "utf8");
  return JSON.parse(raw) as MigrationJournal;
}

export async function listMigrationFiles(root: string): Promise<string[]> {
  const names = await readdir(resolve(root, "drizzle"));
  return names.filter((name) => name.endsWith(".sql")).sort();
}

export function verifyMigrationClasses(input: VerifyInput): {
  errors: string[];
  rows: VerifiedMigration[];
} {
  const errors: string[] = [];
  const registryByTag = new Map<string, MigrationClassEntry>();
  for (const entry of input.registry) {
    if (registryByTag.has(entry.tag)) {
      errors.push(`registry duplicado: ${entry.tag}`);
      continue;
    }
    registryByTag.set(entry.tag, entry);
  }

  const journalTags = new Set<string>();
  for (const entry of input.journalEntries) {
    if (journalTags.has(entry.tag)) errors.push(`journal duplicado: ${entry.tag}`);
    journalTags.add(entry.tag);
  }

  const fileSet = new Set(input.migrationFiles);
  for (const file of input.migrationFiles) {
    const tag = file.replace(/\.sql$/, "");
    if (!journalTags.has(tag)) errors.push(`SQL sem entrada no journal: drizzle/${file}`);
  }

  for (const entry of input.registry) {
    if (!journalTags.has(entry.tag)) {
      errors.push(`registry sem entrada no journal: ${entry.tag}`);
    }
  }

  const rows: VerifiedMigration[] = [];
  for (const entry of input.journalEntries) {
    const classification = registryByTag.get(entry.tag);
    if (!classification) {
      errors.push(`journal sem classificação no registry: ${entry.tag}`);
      continue;
    }

    let ok = true;
    const file = `${entry.tag}.sql`;
    if (!fileSet.has(file)) {
      errors.push(`arquivo ausente para ${entry.tag}: drizzle/${file}`);
      ok = false;
    }

    const actualHash = input.hashes.get(file);
    if (!/^[0-9a-f]{64}$/.test(classification.sha256)) {
      errors.push(`sha256 inválido no registry para ${entry.tag}: ${classification.sha256}`);
      ok = false;
    }
    if (actualHash === undefined) {
      if (fileSet.has(file)) {
        errors.push(`sha256 não calculado para drizzle/${file}`);
        ok = false;
      }
    } else if (actualHash !== classification.sha256) {
      errors.push(
        `sha256 divergente em ${entry.tag}:\n` +
          `  registry: ${classification.sha256}\n` +
          `  arquivo:  ${actualHash}`,
      );
      ok = false;
    }

    if (!MIGRATION_CLASSES.includes(classification.class)) {
      errors.push(`classe inválida em ${entry.tag}: ${String(classification.class)}`);
      ok = false;
    }
    if (!classification.rationale.trim()) {
      errors.push(`rationale vazio em ${entry.tag}`);
      ok = false;
    }
    if (classification.evidence.length === 0) {
      errors.push(`evidence vazia em ${entry.tag}`);
      ok = false;
    }
    if (classification.class === "DATA_MIGRATION") {
      if (classification.idempotent !== true) {
        errors.push(`DATA_MIGRATION ${entry.tag} exige idempotent: true`);
        ok = false;
      }
      if (!classification.rollback.trim()) {
        errors.push(`DATA_MIGRATION ${entry.tag} exige rollback`);
        ok = false;
      }
    }
    if (classification.class === "BREAKING" && !classification.contractOf?.trim()) {
      errors.push(`BREAKING ${entry.tag} exige contractOf apontando para a migration expand`);
      ok = false;
    }

    rows.push({
      idx: entry.idx,
      tag: entry.tag,
      class: classification.class,
      appliedOn: classification.appliedOn,
      sha256: classification.sha256,
      rollback: classification.rollback,
      ok,
    });
  }

  return { errors, rows };
}

export async function classifyProject(root: string): Promise<ClassifyResult> {
  const journal = await loadJournal(root);
  const migrationFiles = await listMigrationFiles(root);
  const hashes = new Map<string, string>();
  for (const file of migrationFiles) {
    hashes.set(file, computeSha256(await readFile(resolve(root, "drizzle", file))));
  }
  const { errors, rows } = verifyMigrationClasses({
    journalEntries: journal.entries,
    migrationFiles,
    registry: migrationClasses,
    hashes,
  });
  return {
    total: journal.entries.length,
    classified: rows.filter((row) => row.ok).length,
    rows,
    errors,
  };
}

function wrap(text: string, label: string): string {
  const firstPrefix = `- ${label}: `;
  const continuation = "  ";
  const words = text.split(/\s+/);
  const lines: string[] = [];
  let current = firstPrefix;
  for (const word of words) {
    const candidate = current === firstPrefix ? current + word : `${current} ${word}`;
    if (candidate.length > 100 && current.trimEnd() !== firstPrefix.trimEnd()) {
      lines.push(current);
      current = `${continuation}${word}`;
    } else {
      current = candidate;
    }
  }
  lines.push(current);
  return lines.join("\n");
}

export interface EvidenceContext {
  date: string;
  journalSha256: string;
}

function renderCodeTable(rows: readonly VerifiedMigration[]): string {
  const header = ["idx", "tag", "classe", "appliedOn", "sha256"];
  const data = rows.map((row) => [String(row.idx), row.tag, row.class, row.appliedOn, row.sha256]);
  const widths = header.map((cell, index) =>
    Math.max(cell.length, ...data.map((row) => row[index].length)),
  );
  const pad = (cells: readonly string[]) =>
    cells
      .map((cell, index) => cell.padEnd(widths[index]))
      .join("  ")
      .trimEnd();
  return [pad(header), ...data.map(pad)].join("\n");
}

export function renderEvidence(result: ClassifyResult, context: EvidenceContext): string {
  const details = result.rows.flatMap((row) => {
    const registry = migrationClasses.find((entry) => entry.tag === row.tag);
    if (!registry) return [];
    const lines = [
      `### ${row.tag} — ${row.class} (appliedOn: ${row.appliedOn})`,
      "",
      wrap(registry.rationale, "Motivo"),
      wrap(registry.evidence.join("; "), "Evidência"),
      wrap(registry.rollback, "Rollback"),
    ];
    if (registry.onlineCare) lines.push(wrap(registry.onlineCare, "Cuidado online"));
    if (registry.idempotent !== undefined) {
      lines.push(`- Idempotente: ${registry.idempotent ? "sim" : "não"}`);
    }
    if (registry.contractOf) lines.push(wrap(registry.contractOf, "ContractOf"));
    lines.push("");
    return lines;
  });

  return [
    `# Classificação das migrations — ${context.date}`,
    "",
    "- Journal canônico: `drizzle/meta/_journal.json`",
    `- sha256 do journal: \`${context.journalSha256}\``,
    "- Registry: `scripts/db/migration-classes.ts`",
    "- Checker: `npx tsx scripts/db/check-migration-classes.ts` — exit 0",
    `- Resultado: **${result.classified}/${result.total} classificadas** (sha256 byte a byte)`,
    "",
    "## Visão geral",
    "",
    "```text",
    renderCodeTable(result.rows),
    "```",
    "",
    "## Detalhes",
    "",
    ...details,
  ].join("\n");
}

async function main(): Promise<void> {
  const root = process.cwd();
  const write = process.argv.includes("--write");
  const result = await classifyProject(root);

  if (result.errors.length > 0) {
    console.error(`✘ ${result.classified}/${result.total} classificadas — divergências:`);
    for (const error of result.errors) console.error(`  - ${error}`);
    process.exitCode = 1;
    return;
  }

  console.log(`✔ ${result.classified}/${result.total} classificadas`);
  if (!write) return;

  const journalSha256 = computeSha256(await readFile(resolve(root, "drizzle/meta/_journal.json")));
  const date = new Date().toISOString().slice(0, 10);
  const relative = `docs/evidence/migration-classification-${date}.md`;
  await writeFile(resolve(root, relative), renderEvidence(result, { date, journalSha256 }), "utf8");
  console.log(`Evidência escrita em ${relative}`);
}

const entrypoint = process.argv[1] ? pathToFileURL(resolve(process.argv[1])).href : "";
if (import.meta.url === entrypoint) {
  const unknown = process.argv.slice(2).filter((arg) => arg !== "--write");
  if (unknown.length > 0) {
    console.error(`Argumento desconhecido: ${unknown.join(" ")} (esperado: --write)`);
    process.exitCode = 2;
  } else {
    await main();
  }
}
