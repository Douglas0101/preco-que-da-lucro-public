import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { brotliCompressSync, constants, gzipSync } from "node:zlib";
import { aggregateSha256, sha256 } from "./lib/bundle-identity.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const publicDir = path.join(root, ".output/public");
const manifestPath = path.join(publicDir, ".vite/manifest.json");
const reportPath = path.join(root, ".artifacts/bundle-report.json");
const entryLimitBytes = 500_000;
const initialGraphLimitBytes = 500_000;

const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
const entries = Object.entries(manifest).filter(
  ([, chunk]) => chunk.isEntry && chunk.file.endsWith(".js"),
);

if (entries.length === 0) {
  throw new Error(`No JavaScript entry found in ${path.relative(root, manifestPath)}`);
}

const measurements = new Map();

async function measure(file) {
  if (measurements.has(file)) return measurements.get(file);

  const contents = await readFile(path.join(publicDir, file));
  const result = {
    file,
    minifiedBytes: contents.byteLength,
    gzipBytes: gzipSync(contents, { level: 9 }).byteLength,
    brotliBytes: brotliCompressSync(contents, {
      params: { [constants.BROTLI_PARAM_QUALITY]: 11 },
    }).byteLength,
    sha256: sha256(contents),
  };
  measurements.set(file, result);
  return result;
}

function collectStaticImports(key, collected = new Set()) {
  if (collected.has(key)) return collected;
  const chunk = manifest[key];

  if (!chunk) throw new Error(`Manifest import ${key} does not exist`);
  if (!chunk.file.endsWith(".js")) return collected;

  collected.add(key);
  for (const importedKey of chunk.imports ?? []) {
    collectStaticImports(importedKey, collected);
  }
  return collected;
}

function sumSizes(chunks) {
  return chunks.reduce(
    (total, chunk) => ({
      minifiedBytes: total.minifiedBytes + chunk.minifiedBytes,
      gzipBytes: total.gzipBytes + chunk.gzipBytes,
      brotliBytes: total.brotliBytes + chunk.brotliBytes,
    }),
    { minifiedBytes: 0, gzipBytes: 0, brotliBytes: 0 },
  );
}

const entryReports = [];

for (const [source, chunk] of entries) {
  const entry = await measure(chunk.file);
  const initialChunks = await Promise.all(
    [...collectStaticImports(source)].map((key) => measure(manifest[key].file)),
  );
  const initialGraph = {
    files: initialChunks.map(({ file }) => file).sort(),
    ...sumSizes(initialChunks),
    sha256: aggregateSha256(initialChunks),
    limitBytes: initialGraphLimitBytes,
  };

  entryReports.push({
    source,
    ...entry,
    limitBytes: entryLimitBytes,
    passed:
      entry.minifiedBytes <= entryLimitBytes &&
      initialGraph.minifiedBytes <= initialGraphLimitBytes,
    initialGraph,
  });
}

const report = {
  schemaVersion: 2,
  commit: process.env.GITHUB_SHA ?? null,
  manifest: path.relative(root, manifestPath),
  budget: {
    entryMinifiedBytes: entryLimitBytes,
    initialGraphMinifiedBytes: initialGraphLimitBytes,
  },
  entries: entryReports,
};

await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

for (const entry of entryReports) {
  const status = entry.passed ? "PASS" : "FAIL";
  console.log(
    `${status} ${entry.file}: ${entry.minifiedBytes} minified, ${entry.gzipBytes} gzip, ${entry.brotliBytes} Brotli bytes, sha256=${entry.sha256.slice(0, 12)}`,
  );
  console.log(
    `Initial graph (${entry.initialGraph.files.length} chunks): ${entry.initialGraph.minifiedBytes} minified, ${entry.initialGraph.gzipBytes} gzip, ${entry.initialGraph.brotliBytes} Brotli bytes, sha256=${entry.initialGraph.sha256.slice(0, 12)}`,
  );
}

if (entryReports.some((entry) => !entry.passed)) process.exitCode = 1;
