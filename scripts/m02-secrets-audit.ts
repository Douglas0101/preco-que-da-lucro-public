import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, extname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const skippedDirectories = new Set([
  ".git",
  ".agents",
  ".codex",
  ".pi",
  ".artifacts",
  ".migration",
  ".neon",
  ".output",
  ".tanstack",
  ".ruff_cache",
  "node_modules",
  "dist",
  "playwright-report",
  "test-results",
  ".p0-closeout-docker",
]);
const textExtensions = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".sh",
  ".json",
  ".yml",
  ".yaml",
  ".md",
  ".toml",
  ".sql",
]);
const keyPattern = /^[A-Za-z_][A-Za-z0-9_]*$/;
const compare = (a: string, b: string): number => a.localeCompare(b);
const isEnv = (name: string): boolean =>
  name === ".env" || name.startsWith(".env.") || name.endsWith(".env");

export function envKeyNames(content: string): string[] {
  return [
    ...new Set(
      content.split("\n").flatMap((line) => {
        const trimmed = line.trim().replace(/^export\s+/, "");
        const eq = trimmed.indexOf("=");
        const key = trimmed.slice(0, eq).trim();
        return eq > 0 && keyPattern.test(key) ? [key] : [];
      }),
    ),
  ].sort(compare);
}

interface Entry {
  name: string;
  defined_in: string[];
  consumers_code: string[];
  consumers_ci: string[];
  references_docs: string[];
  classification: "consumer" | "docs-only" | "orphan-candidate" | "unknown";
}

export function auditSecrets(root: string, ciNames: string[] = []) {
  const startedAt = new Date().toISOString();
  const definitions = new Map<string, Set<string>>();
  const contents = new Map<string, string>();
  const excluded: { path: string; reason: string }[] = [];
  const failures: { path: string; reason: string }[] = [];
  const literalCandidates: { path: string; line: number; kind: string }[] = [];
  let scannedFiles = 0;
  function define(key: string, source: string) {
    if (!keyPattern.test(key)) throw new Error("invalid CI metadata key");
    const sources = definitions.get(key) ?? new Set<string>();
    sources.add(source);
    definitions.set(key, sources);
  }
  function walk(dir: string, prefix = "") {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      failures.push({ path: prefix || ".", reason: "directory-unreadable" });
      return;
    }
    for (const entry of entries) {
      const path = prefix ? prefix + "/" + entry.name : entry.name;
      const absolute = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) {
        excluded.push({ path, reason: "symlink-not-followed" });
        continue;
      }
      if (entry.isDirectory()) {
        if (skippedDirectories.has(entry.name) || entry.name.startsWith(".worktree-"))
          excluded.push({ path, reason: "generated-vendor-or-private" });
        else walk(absolute, path);
        continue;
      }
      if (!entry.isFile()) continue;
      if (
        path.startsWith("docs/evidence/") ||
        entry.name === "package-lock.json" ||
        path.includes("secrets-audit") ||
        path.includes(".test.")
      ) {
        excluded.push({ path, reason: "evidence-auditor-or-test-not-consumer" });
        continue;
      }
      if (!isEnv(entry.name) && !textExtensions.has(extname(entry.name))) continue;
      try {
        if (lstatSync(absolute).size > 1024 * 1024) {
          failures.push({ path, reason: "file-over-1MiB" });
          continue;
        }
        const content = readFileSync(absolute, "utf8");
        scannedFiles++;
        if (isEnv(entry.name)) {
          for (const key of envKeyNames(content)) define(key, path);
          continue;
        }
        contents.set(path, content);
        if (path.startsWith(".github/workflows/"))
          for (const match of content.matchAll(/secrets\.([A-Za-z_][A-Za-z0-9_]*)/g))
            define(match[1], "github-workflow-reference (existence unverified)");
        content.split("\n").forEach((line, index) => {
          if (
            /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(line) ||
            /\b(?:ghp_|github_pat_|sk-proj-)[A-Za-z0-9_-]{20,}/.test(line) ||
            /\bAKIA[A-Z0-9]{16}\b/.test(line)
          )
            literalCandidates.push({
              path,
              line: index + 1,
              kind: "possible-secret-literal; value omitted; liveness unknown",
            });
        });
      } catch {
        failures.push({ path, reason: "file-unreadable" });
      }
    }
  }
  walk(resolve(root));
  ciNames.forEach((name) => define(name, "github-metadata (name only)"));
  const entries: Entry[] = [...definitions]
    .map(([name, sources]) => {
      const code: string[] = [],
        ci: string[] = [],
        docs: string[] = [];
      for (const [path, content] of contents) {
        // Lexical references are candidates, not proof of runtime use.
        if (!content.split(/[^A-Za-z0-9_]+/).includes(name)) continue;
        if (path.startsWith(".github/")) ci.push(path);
        else if (
          (path.startsWith("src/") ||
            path.startsWith("scripts/") ||
            path.startsWith("e2e/") ||
            basename(path) === "docker-compose.yml") &&
          extname(path) !== ".md"
        )
          code.push(path);
        else docs.push(path);
      }
      let classification: Entry["classification"] = "orphan-candidate";
      if (failures.length) classification = "unknown";
      else if (code.length + ci.length) classification = "consumer";
      else if (docs.length) classification = "docs-only";
      return {
        name,
        defined_in: [...sources].sort(compare),
        consumers_code: code.sort(compare),
        consumers_ci: ci.sort(compare),
        references_docs: docs.sort(compare),
        classification,
      };
    })
    .sort((a, b) => compare(a.name, b.name));
  return {
    check: "m02:secrets-audit",
    read_only: true,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    result: failures.length ? "INCOMPLETE" : "COMPLETE_WITH_LIMITS",
    limits:
      "Lexical consumer map; does not prove credential liveness or absence of manual/external consumers. Never authorizes revocation. Env values are discarded; CI metadata contains names only. Evidence, private/vendor directories, tests and symlinks are excluded.",
    coverage: { scanned_files: scannedFiles, exclusions: excluded, failures },
    summary: {
      defined: entries.length,
      consumers: entries.filter((e) => e.classification === "consumer").length,
      review_required: entries.filter((e) => e.classification !== "consumer").length,
    },
    review_required: entries.filter((e) => e.classification !== "consumer").map((e) => e.name),
    possible_secret_literals: literalCandidates,
    entries,
  };
}

// Raiz fixa no repositório e metadados de CI por caminho convencional fixo:
// sem argumentos de CLI, para não criar fluxo de path-injection (S2083) a
// partir de process.argv. Testes chamam auditSecrets diretamente com o
// diretório-fixture.
// Para incluir nomes de secrets do GitHub (opcional):
//   gh secret list --json name > .artifacts/m02-secrets-audit-ci.json
const CI_METADATA_PATH = resolve(import.meta.dirname, "../.artifacts/m02-secrets-audit-ci.json");

function readCiNames(): string[] {
  if (!existsSync(CI_METADATA_PATH)) return [];
  const parsed: unknown = JSON.parse(readFileSync(CI_METADATA_PATH, "utf8"));
  if (
    !Array.isArray(parsed) ||
    parsed.some(
      (entry) =>
        typeof entry !== "object" ||
        entry === null ||
        typeof (entry as { name?: unknown }).name !== "string" ||
        !keyPattern.test((entry as { name: string }).name),
    )
  )
    throw new Error("invalid CI metadata");
  return parsed.map((entry) => (entry as { name: string }).name);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const report = auditSecrets(resolve(import.meta.dirname, ".."), readCiNames());
    console.log(JSON.stringify(report, null, 2));
    // Veredicto: `2` = precondicao (cobertura incompleta), `1` = violacao (literal de segredo
    // detectado), `0` = limpo. Ate 2026-09-23 o exit code olhava APENAS a cobertura, entao a guarda
    // detectava o literal em `possible_secret_literals` e ainda assim saia `0` — encadea-la assim
    // daria cobertura de segredo apenas aparente (achado do ciclo SDD-20260923, ADR-030 §9).
    if (report.coverage.failures.length) process.exitCode = 2;
    else if (report.possible_secret_literals.length) process.exitCode = 1;
    else process.exitCode = 0;
    // Legibilidade sem vazar valor: nomeia onde reprovou (arquivo:linha), nunca o conteudo.
    for (const literal of report.possible_secret_literals)
      console.error(
        `m02-secrets-audit: possible secret literal at ${literal.path}:${literal.line} (${literal.kind})`,
      );
  } catch {
    console.error(
      JSON.stringify({
        check: "m02:secrets-audit",
        result: "ERROR",
        error:
          "Inaccessible repository root or invalid CI metadata; details withheld to protect secrets.",
      }),
    );
    process.exitCode = 2;
  }
}
