import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

type Matrix = {
  counts: {
    bffModules: number;
    createServerFnDeclarations: number;
    concreteOperations: number;
    apiRoutes: number;
    transactionSites: number;
    directDatabaseFiles: number;
  };
  bffs: Array<{
    path: string;
    reachesDatabase: boolean;
    databasePaths: string[];
    operations: Array<{
      name: string;
      declaration: string;
      service: unknown;
      repository: unknown;
      atomicity: unknown;
    }>;
  }>;
  routes: unknown[];
  directDatabaseFiles: string[];
  policy: {
    exceptions: Array<{ id: string; pathPrefix: string; reason: string }>;
    entryPolicies: Record<string, Record<string, unknown>>;
    catalog: {
      services: Record<string, { path: string; status: string }>;
      repositories: Record<string, { path: string; status: string }>;
    };
    transactionPolicies: Record<
      string,
      {
        atomicity?: unknown;
        units?: Array<{
          id?: unknown;
          boundary?: unknown;
          evidence?: unknown;
          idempotencyKey?: unknown;
        }>;
      }
    >;
  };
  transactionSites: Array<{
    path: string;
    line: number;
    expression: string;
    classification: string;
  }>;
};

const repositoryRoot = resolve(import.meta.dirname, "..");
const matrixPath = resolve(repositoryRoot, "docs/specs/M-02/matrix.yaml");

function loadMatrix(): Matrix {
  try {
    return JSON.parse(readFileSync(matrixPath, "utf8")) as Matrix;
  } catch (error) {
    // Precondicao, nao violacao: sem a matriz nao ha o que auditar. Antes desta correcao o erro
    // subia cru (`node:fs` stack) e o processo saia `1`, indistinguivel de uma boundary violada —
    // AC-02 do SDD-20260923-boundary-guard-dbt19 exige a distincao (`2` de precondicao).
    console.error(
      `M-02 boundary precondition failed: cannot read ${matrixPath.replace(`${repositoryRoot}/`, "")} (${(error as Error).message})`,
    );
    process.exit(2);
  }
}

function isAllowed(path: string, matrix: Matrix): boolean {
  if (matrix.policy.exceptions.some((entry) => path.startsWith(entry.pathPrefix))) return true;
  return path.startsWith("src/server/repositories/");
}

const matrix = loadMatrix();
const violations = matrix.bffs.flatMap((entry) =>
  entry.databasePaths
    .filter((path) => !isAllowed(path, matrix))
    .map((path) => ({ bff: entry.path, path })),
);
const missingPolicies = matrix.bffs
  .map((entry) => entry.path)
  .filter((path) => !(path in matrix.policy.entryPolicies));
const missingOperationMappings = matrix.bffs.flatMap((entry) =>
  entry.operations
    .filter(
      (operation) =>
        typeof operation.service !== "string" ||
        operation.service.length === 0 ||
        operation.atomicity === undefined,
    )
    .map((operation) => `${entry.path}:${operation.name}`),
);
const missingCatalogPaths = Object.values({
  ...matrix.policy.catalog.services,
  ...matrix.policy.catalog.repositories,
})
  // contract-only entries are forward declarations for M-04/M-05; the spec
  // keeps their implementations in those modules, so the files do not exist yet.
  .filter((entry) => entry.status !== "contract-only")
  .map((entry) => entry.path)
  .filter((path) => !existsSync(resolve(repositoryRoot, path)));
const computedCounts = {
  bffModules: matrix.bffs.length,
  createServerFnDeclarations: matrix.bffs.reduce(
    (total, entry) =>
      total +
      entry.operations.filter((operation) => operation.declaration === "createServerFn").length,
    0,
  ),
  concreteOperations: matrix.bffs.reduce((total, entry) => total + entry.operations.length, 0),
  apiRoutes: matrix.routes.length,
  transactionSites: matrix.transactionSites.length,
  directDatabaseFiles: new Set(matrix.directDatabaseFiles).size,
};
const countMismatches = Object.entries(computedCounts)
  .filter(([key, value]) => matrix.counts[key as keyof typeof computedCounts] !== value)
  .map(
    ([key, value]) =>
      `${key}: declared=${matrix.counts[key as keyof typeof computedCounts]}, actual=${value}`,
  );
const duplicateDatabaseFiles = matrix.directDatabaseFiles.filter(
  (path, index, paths) => paths.indexOf(path) !== index,
);
const malformedTransactionSites = matrix.transactionSites.filter(
  (entry) =>
    typeof entry.path !== "string" ||
    !Number.isInteger(entry.line) ||
    typeof entry.expression !== "string" ||
    typeof entry.classification !== "string",
);
const unclassifiedTransactions = matrix.transactionSites.filter(
  (entry) =>
    !["auth-allowlist", "repository-fallback", "compatibility-facade"].includes(
      entry.classification,
    ),
);
const sendChatPolicy = matrix.policy.transactionPolicies["src/lib/chat.functions.ts"];
const expectedSendChatUnits = [
  "chat-reservation-history",
  "model-round-reserve",
  "model-round-settle",
  "budget-sweep",
  "tool-execution-replay",
  "audit-append",
];
const sendChatUnits = sendChatPolicy?.units ?? [];
const missingSendChatUnits = expectedSendChatUnits.filter(
  (id) => !sendChatUnits.some((unit) => unit.id === id),
);
const malformedSendChatUnits = sendChatUnits.filter(
  (unit) =>
    typeof unit.id !== "string" ||
    typeof unit.boundary !== "string" ||
    typeof unit.evidence !== "string" ||
    unit.evidence.length === 0,
);

if (
  violations.length ||
  missingPolicies.length ||
  missingOperationMappings.length ||
  missingCatalogPaths.length ||
  countMismatches.length ||
  duplicateDatabaseFiles.length ||
  malformedTransactionSites.length ||
  unclassifiedTransactions.length ||
  sendChatPolicy?.atomicity !== "composed" ||
  missingSendChatUnits.length ||
  malformedSendChatUnits.length
) {
  console.error("M-02 boundary violations:");
  for (const violation of violations) console.error(`- ${violation.bff} -> ${violation.path}`);
  for (const path of missingPolicies) console.error(`- missing entry policy: ${path}`);
  for (const operation of missingOperationMappings) {
    console.error(`- missing operation mapping: ${operation}`);
  }
  for (const path of missingCatalogPaths) console.error(`- missing catalog path: ${path}`);
  for (const mismatch of countMismatches) console.error(`- matrix count mismatch: ${mismatch}`);
  for (const path of duplicateDatabaseFiles) console.error(`- duplicate database file: ${path}`);
  for (const entry of malformedTransactionSites) {
    console.error(`- malformed transaction site: ${JSON.stringify(entry)}`);
  }
  for (const entry of unclassifiedTransactions) {
    console.error(`- unclassified transaction: ${JSON.stringify(entry)}`);
  }
  if (sendChatPolicy?.atomicity !== "composed") {
    console.error("- sendChatMessage must use composed transaction policy");
  }
  for (const id of missingSendChatUnits) {
    console.error(`- missing sendChatMessage unit: ${id}`);
  }
  for (const unit of malformedSendChatUnits) {
    console.error(`- malformed sendChatMessage unit: ${JSON.stringify(unit)}`);
  }
  process.exitCode = 1;
} else {
  console.log(
    "M-02 BFF boundary is clean: all database reachability is allowlisted or repository-only.",
  );
}
