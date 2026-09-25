import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { arch, release, type as osType } from "node:os";
import { basename, dirname, relative, resolve, sep } from "node:path";
import { parseArgs } from "node:util";

const repositoryRoot = resolve(import.meta.dirname, "..");
const repositoryRealPath = realpathSync(repositoryRoot);

interface IncludeEntry {
  source_path: string;
  stored_as: string;
  bytes: number;
  sha256: string;
}

function sha256(bytes: string | Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function git(...args: string[]): string {
  return execFileSync("/usr/bin/git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
  }).trim();
}

const ENV_NAME_PATTERN =
  /^(DATABASE|BETTER_AUTH|AUTH_|AI_|RESEND|OTEL|NODE_|PORT|HOST|SUPABASE|MIGRATION|E2E_|EXPECTED_|GITHUB_SHA|BUILD_|CSP_|NEON_)/;

function fail(error: string): never {
  console.error(
    JSON.stringify({
      check: "m02:forensic-bundle",
      result: "ERROR",
      error,
    }),
  );
  process.exit(2);
}

function existingParent(candidate: string, label: string): { lexical: string; real: string } {
  let lexical = dirname(candidate);
  while (!existsSync(lexical)) {
    const parent = dirname(lexical);
    if (parent === lexical) fail(`${label} não pode ser resolvido dentro do repositório`);
    lexical = parent;
  }
  const real = realpathSync(lexical);
  if (real !== repositoryRealPath && !real.startsWith(repositoryRealPath + sep)) {
    throw new Error(`${label} aponta para fora do repositório; fail-closed`);
  }
  return { lexical, real };
}

function createOutputDirectory(raw: string, label: string): string {
  const candidate = resolve(repositoryRealPath, raw);
  if (candidate !== repositoryRealPath && !candidate.startsWith(repositoryRealPath + sep)) {
    throw new Error(`${label} aponta para fora do repositório; fail-closed`);
  }
  const parent = existingParent(candidate, label);
  const tail = relative(parent.lexical, candidate);
  const safeCandidate = resolve(parent.real, tail);
  if (safeCandidate !== repositoryRealPath && !safeCandidate.startsWith(repositoryRealPath + sep)) {
    throw new Error(`${label} aponta para fora do repositório; fail-closed`);
  }
  if (existsSync(safeCandidate)) fail("destino já existe; fail-closed, sem sobrescrita");

  mkdirSync(safeCandidate, { recursive: true });
  const outputDirectory = realpathSync(safeCandidate);
  if (
    outputDirectory !== repositoryRealPath &&
    !outputDirectory.startsWith(repositoryRealPath + sep)
  ) {
    throw new Error(`${label} aponta para fora do repositório; fail-closed`);
  }
  return outputDirectory;
}

function resolveOutputPath(base: string, name: string): string {
  const safeBase = realpathSync(base);
  if (safeBase !== repositoryRealPath && !safeBase.startsWith(repositoryRealPath + sep)) {
    throw new Error("saída do bundle aponta para fora do repositório; fail-closed");
  }
  const candidate = resolve(safeBase, name);
  const parent = existingParent(candidate, "saída do bundle");
  if (parent.real !== safeBase && !parent.real.startsWith(safeBase + sep)) {
    throw new Error("saída do bundle aponta para fora da base permitida; fail-closed");
  }
  const safeCandidate = resolve(parent.real, relative(parent.lexical, candidate));
  if (safeCandidate !== safeBase && !safeCandidate.startsWith(safeBase + sep)) {
    throw new Error("saída do bundle aponta para fora da base permitida; fail-closed");
  }
  if (existsSync(safeCandidate)) fail("arquivo de saída já existe; fail-closed, sem sobrescrita");
  return safeCandidate;
}

function resolveIncludedFile(raw: string): string {
  const candidate = resolve(repositoryRealPath, raw);
  if (candidate !== repositoryRealPath && !candidate.startsWith(repositoryRealPath + sep)) {
    throw new Error("--include aponta para fora do repositório; fail-closed");
  }
  let realCandidate: string;
  try {
    realCandidate = realpathSync(candidate);
  } catch {
    fail(`--include não é arquivo regular: ${raw}`);
  }
  if (realCandidate !== repositoryRealPath && !realCandidate.startsWith(repositoryRealPath + sep)) {
    throw new Error("--include resolve para fora do repositório; fail-closed");
  }
  if (!statSync(realCandidate).isFile()) {
    fail(`--include não é arquivo regular: ${raw}`);
  }
  return realCandidate;
}

function main(): void {
  const { values } = parseArgs({
    options: {
      out: { type: "string" },
      note: { type: "string" },
      include: { type: "string", multiple: true },
    },
    strict: true,
  });
  if (!values.out)
    fail("--out <dir> é obrigatório (--note e --include <arquivo> são opcionais e repetíveis)");
  const outDir = createOutputDirectory(values.out, "--out");

  const startedAt = new Date().toISOString();

  const head = git("rev-parse", "HEAD");
  const branch = git("branch", "--show-current");
  const statusShort = git("status", "--short", "--untracked-files=all");

  // Somente NOMES de variáveis; valores de ambiente nunca são emitidos.
  const envVarNames = Object.keys(process.env)
    .filter((key) => ENV_NAME_PATTERN.test(key))
    .sort((left, right) =>
      left.localeCompare(right, "en", { numeric: false, sensitivity: "variant" }),
    );
  writeFileSync(resolveOutputPath(outDir, "env-var-names.txt"), envVarNames.join("\n") + "\n");

  const includes: IncludeEntry[] = [];
  const requested: string[] = values.include ?? [];
  for (let i = 0; i < requested.length; i++) {
    const source = resolveIncludedFile(requested[i]!);
    const storedAs = i === 0 ? basename(source) : `${i}-${basename(source)}`;
    const dest = resolveOutputPath(outDir, storedAs);
    copyFileSync(source, dest);
    const bytes = readFileSync(dest);
    includes.push({
      source_path: source,
      stored_as: storedAs,
      bytes: bytes.length,
      sha256: sha256(bytes),
    });
  }

  const manifest = {
    check: "m02:forensic-bundle",
    fail_closed: true,
    started_at: startedAt,
    finished_at: new Date().toISOString(),
    note: values.note ?? "",
    repository: {
      branch,
      head,
      dirty: statusShort.length > 0,
      status_short: statusShort.split("\n").filter(Boolean).slice(0, 50),
    },
    versions: {
      node: process.versions.node,
      npm: process.versions.npm,
      platform: process.platform,
      os_type: osType(),
      os_release: release(),
      arch: arch(),
    },
    env_var_names: envVarNames,
    limits:
      "Nomes de variáveis apenas; nenhum valor de ambiente ou segredo é emitido. O caller só informa --include com saídas já redigidas.",
    includes,
  };

  const manifestPath = resolveOutputPath(outDir, "manifest.json");
  const tmpPath = resolveOutputPath(outDir, ".manifest.json.tmp");
  const manifestText = JSON.stringify(manifest, null, 2) + "\n";
  writeFileSync(tmpPath, manifestText);
  renameSync(tmpPath, manifestPath);

  const sums = [
    ...includes.map((inc) => `${inc.sha256}  ${inc.stored_as}`),
    `${sha256(readFileSync(manifestPath))}  manifest.json`,
  ];
  const sumsPath = resolveOutputPath(outDir, "SHA256SUMS");
  writeFileSync(sumsPath, sums.join("\n") + "\n");

  console.log(
    JSON.stringify(
      {
        check: "m02:forensic-bundle",
        result: "PASS",
        out: outDir,
        note: values.note ?? "",
        includes: includes.length,
        env_var_names: envVarNames.length,
        finished_at: manifest.finished_at,
      },
      null,
      2,
    ),
  );
  process.exitCode = 0;
}

try {
  main();
} catch {
  fail("captura do bundle falhou; verifique --out/--include e permissões. Detalhes suprimidos.");
}
