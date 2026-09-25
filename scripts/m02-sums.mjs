// m02-sums.mjs — SUMS mecânico dos bundles de evidência (rodada PENDENTES-CLOSE
// retomada, Q1 do roteiro L32–48).
//
// Contrato:
//   npm run m02:sums [--] [--verify] [--release-gsec] [--root <dir>]
//   - Regenera TODOS os SHA256SUMS dos bundles de evidência (dirs sob a raiz
//     de bundles que contêm um SHA256SUMS) com paths root-relative e verifica
//     a partir da raiz — in-process (node:crypto), mesma semântica de
//     `sha256sum -c` da raiz, sem spawn (imune ao EPERM observado em coletor
//     com sandbox restrito).
//   - Saída por bundle: status verde/vermelho + nomes dos falhos; exit 0 só
//     se todos verdes OU vermelhos esperados rotulados.
//   - Rótulo de exceção ÚNICO e DATADO (roteiro L40–42): bundle gsec =
//     "vermelho-esperado até assinatura do memo (V0)", com os 2 caminhos
//     nomeados pinados aos hashes selados originais. Escopo: SOMENTE o bundle
//     gsec — nos demais bundles os mesmos arquivos regeneram com hash atual.
//     Pós-V0 (passo H1 da fila humana): `--release-gsec` grava o marcador
//     `.gsec-exception-released` e derruba os pinos; daí em diante qualquer
//     vermelho é hard fail (exit 2).
//   - Conjunto de entradas = paths do SUMS existente ∪ arquivos atuais do
//     bundle (recursivo; ocultos e o próprio SHA256SUMS fora). Caminho selado
//     ausente no disco = fail-closed (nada é reescrito).
//   - Ordenação obrigatória (roteiro L37–39): assinatura/appends → m02:sums →
//     -c verde → staging. Nunca staging com SUMS vermelho.
//   - Idempotente byte-a-byte: rodar 2× produz os mesmos bytes (ordem
//     lexicográfica, LF, `<hash>␣␣<path>` — compatível `sha256sum -c`).
// Exit codes: 0 verde-ou-rotulado · 1 vermelho não-rotulado · 2 fail-closed
// (caminho selado ausente, SUMS malformado, erro interno, vermelho pós-V0).

import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { basename, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT_DIR = resolve(fileURLToPath(import.meta.url), "..", "..");
const ROOT_REAL_DIR = realpathSync(ROOT_DIR);
const SUMS_NAME = "SHA256SUMS";

// Rótulo de exceção único e datado (roteiro L40–42). Pinado aos hashes selados
// originais do gsec; liberado somente pelo passo H1 pós-V0 (--release-gsec).
const GSEC_EXCEPTION = {
  bundle: "gsec-2026-09-06",
  label: "vermelho-esperado até assinatura do memo (V0)",
  marker: ".gsec-exception-released",
  pins: {
    "scripts/env-guard.mjs": "7f3247f2ba8bbdc16f9ff47fb152a579f5961ae3c8b3209e61d17073d7d9c062",
    "docs/specs/M-02/emenda-2026-09-07-env-guard.md":
      "efc0d47ada34fbf990ea3896c22445592f59e09082ca5dab4d834d6af1003acf",
  },
};

function usage() {
  return [
    "uso: npm run m02:sums -- [--verify] [--release-gsec] [--root <dir>]",
    "Regra de ordenação (roteiro L37–39): assinatura/appends → m02:sums → -c verde → staging.",
    "Rótulo gsec único e datado até V0; após --release-gsec qualquer vermelho é hard fail (exit 2).",
  ].join("\n");
}

function parseArgs(argv) {
  const parsed = { verify: false, releaseGsec: false, root: "docs/evidence" };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const take = (name) => {
      if (arg.startsWith(`--${name}=`)) return arg.slice(name.length + 3);
      if (arg === `--${name}`) {
        index += 1;
        return argv[index];
      }
      return undefined;
    };
    if (arg === "--verify") {
      parsed.verify = true;
      continue;
    }
    if (arg === "--release-gsec") {
      parsed.releaseGsec = true;
      continue;
    }
    const root = take("root");
    if (root !== undefined) {
      parsed.root = root;
      continue;
    }
    return { error: `argumento não reconhecido: ${arg}` };
  }
  if (!/^[A-Za-z0-9._/-]+$/.test(parsed.root) || parsed.root.split("/").includes("..")) {
    return { error: "--root exige caminho simples dentro do repositório" };
  }
  return parsed;
}

function sha256OfFile(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function comparePaths(left, right) {
  return left.localeCompare(right, "en", { numeric: false, sensitivity: "variant" });
}

function isWithin(base, candidate) {
  const descendant = relative(base, candidate);
  return descendant === "" || (!descendant.startsWith(`..${sep}`) && !isAbsolute(descendant));
}

function resolveBundleRoot(raw) {
  const candidate = resolve(ROOT_REAL_DIR, raw);
  if (!isWithin(ROOT_REAL_DIR, candidate)) {
    return { error: "--root deve permanecer dentro do repositório; fail-closed" };
  }
  try {
    const real = realpathSync(candidate);
    if (!isWithin(ROOT_REAL_DIR, real)) {
      return { error: "--root resolve para fora do repositório; fail-closed" };
    }
    if (!statSync(real).isDirectory()) return { error: "--root não é um diretório" };
    return { path: real };
  } catch {
    return { error: "--root não pode ser resolvido; fail-closed" };
  }
}

function resolveRootRelativePath(rootDir, rawPath) {
  if (
    typeof rawPath !== "string" ||
    rawPath.trim() === "" ||
    isAbsolute(rawPath) ||
    /^[A-Za-z]:[\\/]/.test(rawPath) ||
    rawPath.split(/[\\/]/).includes("..")
  ) {
    return { error: "caminho SUMS deve ser relativo e sem traversal" };
  }
  const candidate = resolve(rootDir, rawPath);
  if (!isWithin(rootDir, candidate)) return { error: "caminho SUMS fora da raiz" };
  if (!existsSync(candidate)) return { path: candidate };
  try {
    const real = realpathSync(candidate);
    if (!isWithin(rootDir, real) || real !== candidate) {
      return { error: "caminho SUMS usa symlink ou resolve para fora da raiz" };
    }
    if (!statSync(real).isFile()) return { error: "caminho SUMS não é arquivo regular" };
    return { path: real };
  } catch {
    return { error: "caminho SUMS não pode ser resolvido" };
  }
}

function discoverBundles(bundleRoot) {
  return readdirSync(bundleRoot, { withFileTypes: true })
    .filter((dirent) => dirent.isDirectory() && !dirent.name.startsWith("."))
    .map((dirent) => join(bundleRoot, dirent.name))
    .filter((dir) => existsSync(join(dir, SUMS_NAME)))
    .sort(comparePaths)
    .map((dir) => ({ name: basename(dir), dir, sumsPath: join(dir, SUMS_NAME) }));
}

function parseSums(text) {
  const entries = [];
  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    const match = /^([0-9a-f]{64})  (.+)$/.exec(line);
    if (!match) return { error: `linha malformada no SUMS: ${line.slice(0, 72)}` };
    entries.push({ hash: match[1], path: match[2] });
  }
  return { entries };
}

function collectBundleFiles(rootDir, bundleDir) {
  const found = [];
  const walk = (current) => {
    for (const dirent of readdirSync(current, { withFileTypes: true })) {
      if (dirent.name.startsWith(".")) continue;
      const full = join(current, dirent.name);
      if (dirent.isDirectory()) walk(full);
      else if (dirent.isFile() && dirent.name !== SUMS_NAME) found.push(relative(rootDir, full));
    }
  };
  walk(bundleDir);
  return found.sort(comparePaths);
}

function buildSumsContent(entries) {
  const sorted = [...entries].sort((left, right) => comparePaths(left.path, right.path));
  return `${sorted.map((entry) => `${entry.hash}  ${entry.path}`).join("\n")}\n`;
}

function verifyEntries(entries, options) {
  const { rootDir, bundleName, exceptionActive } = options;
  const pinning = exceptionActive && bundleName === GSEC_EXCEPTION.bundle;
  const failed = [];
  const missingPinned = [];
  const invalidPaths = [];
  let ok = 0;
  for (const entry of entries) {
    const resolved = resolveRootRelativePath(rootDir, entry.path);
    if (resolved.error) {
      invalidPaths.push(`${entry.path}: ${resolved.error}`);
      continue;
    }
    const absolute = resolved.path;
    const isPinned = pinning && GSEC_EXCEPTION.pins[entry.path] === entry.hash;
    if (!existsSync(absolute)) {
      if (isPinned) missingPinned.push(entry.path);
      else failed.push({ path: entry.path, expected: entry.hash, actual: null, labeled: false });
      continue;
    }
    const actual = sha256OfFile(absolute);
    if (actual === entry.hash) {
      ok += 1;
      continue;
    }
    failed.push({ path: entry.path, expected: entry.hash, actual, labeled: isPinned });
  }
  const status =
    invalidPaths.length > 0
      ? "INVALID-PATH"
      : failed.length === 0
        ? "GREEN"
        : failed.every((failure) => failure.labeled)
          ? "RED-LABELED"
          : "RED-UNLABELED";
  return { total: entries.length, ok, failed, missingPinned, invalidPaths, status };
}

function regenBundle(bundle, options) {
  const { rootDir, exceptionActive } = options;
  const current = parseSums(readFileSync(bundle.sumsPath, "utf8"));
  if (current.error) return { error: `${bundle.name}: ${current.error}` };
  const pathSet = new Set([
    ...current.entries.map((entry) => entry.path),
    ...collectBundleFiles(rootDir, bundle.dir),
  ]);
  const pinning = exceptionActive && bundle.name === GSEC_EXCEPTION.bundle;
  const entries = [];
  for (const path of [...pathSet].sort(comparePaths)) {
    const resolved = resolveRootRelativePath(rootDir, path);
    if (resolved.error) return { error: `${bundle.name}: ${path}: ${resolved.error}` };
    const absolute = resolved.path;
    if (!existsSync(absolute)) {
      return { error: `${bundle.name}: caminho selado ausente no disco: ${path}` };
    }
    const pinHash = pinning ? GSEC_EXCEPTION.pins[path] : undefined;
    entries.push({ hash: pinHash ?? sha256OfFile(absolute), path });
  }
  writeFileSync(bundle.sumsPath, buildSumsContent(entries), "utf8");
  return { entries };
}

function releaseGsecException(parsed, markerPath) {
  if (!parsed.releaseGsec || existsSync(markerPath)) return;
  writeFileSync(
    markerPath,
    `exceção gsec liberada em ${new Date().toISOString()} (passo H1 pós-V0; roteiro L41–42)\n`,
    "utf8",
  );
  process.stdout.write(
    `${JSON.stringify({ tool: "m02-sums", event: "gsec-exception-released", marker: relative(ROOT_DIR, markerPath), label: GSEC_EXCEPTION.label })}\n`,
  );
}

function entriesForBundle(bundle, parsed, exceptionActive) {
  if (parsed.verify) {
    const current = parseSums(readFileSync(bundle.sumsPath, "utf8"));
    if (current.error) return { error: `${bundle.name}: ${current.error}` };
    return { entries: current.entries };
  }
  const regen = regenBundle(bundle, { rootDir: ROOT_DIR, exceptionActive });
  if (regen.error) return { error: regen.error };
  return { entries: regen.entries };
}

function processBundle(bundle, parsed, exceptionActive) {
  const loaded = entriesForBundle(bundle, parsed, exceptionActive);
  if (loaded.error) {
    process.stderr.write(`m02-sums: ${loaded.error}\n`);
    return { fatal: true, worst: 2 };
  }
  const result = verifyEntries(loaded.entries, {
    rootDir: ROOT_DIR,
    bundleName: bundle.name,
    exceptionActive,
  });
  if (result.missingPinned.length > 0) {
    process.stderr.write(
      `m02-sums: ${bundle.name}: caminho pinado ausente no disco (fail-closed): ${result.missingPinned.join(", ")}\n`,
    );
    return { fatal: true, worst: 2 };
  }
  if (result.invalidPaths.length > 0) {
    process.stderr.write(
      `m02-sums: ${bundle.name}: caminho inválido no SUMS (fail-closed): ${result.invalidPaths.join(", ")}\n`,
    );
    return { fatal: true, worst: 2 };
  }
  process.stdout.write(
    `${JSON.stringify({
      bundle: bundle.name,
      total: result.total,
      ok: result.ok,
      failed: result.failed,
      status: result.status,
      regenerated: !parsed.verify,
      gsec_label:
        bundle.name === GSEC_EXCEPTION.bundle && exceptionActive ? GSEC_EXCEPTION.label : undefined,
    })}\n`,
  );
  if (result.status !== "RED-UNLABELED") return { fatal: false, worst: 0 };
  const postV0Gsec = bundle.name === GSEC_EXCEPTION.bundle && !exceptionActive;
  return { fatal: false, worst: postV0Gsec ? 2 : 1 };
}

function main() {
  const parsed = parseArgs(process.argv.slice(2));
  if (parsed.error) {
    process.stderr.write(`m02-sums: ${parsed.error}\n${usage()}\n`);
    process.exitCode = 2;
    return;
  }
  const bundleRootResult = resolveBundleRoot(parsed.root);
  if (bundleRootResult.error) {
    process.stderr.write(`m02-sums: ${bundleRootResult.error}\n`);
    process.exitCode = 2;
    return;
  }
  const bundleRoot = bundleRootResult.path;
  const bundles = discoverBundles(bundleRoot);
  if (bundles.length === 0) {
    process.stderr.write("m02-sums: nenhum bundle com SHA256SUMS encontrado (fail-closed)\n");
    process.exitCode = 2;
    return;
  }

  const markerPath = join(bundleRoot, GSEC_EXCEPTION.bundle, GSEC_EXCEPTION.marker);
  releaseGsecException(parsed, markerPath);
  const exceptionActive = !existsSync(markerPath);
  const mode = parsed.verify ? "verify" : "regen";
  let worst = 0;

  for (const bundle of bundles) {
    const outcome = processBundle(bundle, parsed, exceptionActive);
    worst = Math.max(worst, outcome.worst);
    if (outcome.fatal) break;
  }

  process.stdout.write(
    `${JSON.stringify({
      tool: "m02-sums",
      bundles: bundles.length,
      mode,
      gsec_exception: exceptionActive ? "active" : "released",
      result: worst === 0 ? "PASS" : "FAIL",
    })}\n`,
  );
  process.exitCode = worst;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}

export {
  GSEC_EXCEPTION,
  buildSumsContent,
  discoverBundles,
  main,
  parseArgs,
  parseSums,
  sha256OfFile,
  verifyEntries,
};
