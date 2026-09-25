import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const repositoryRoot = resolve(import.meta.dirname, "..");
const ledgerPath = resolve(repositoryRoot, "EXECUTION-STATE-PROGRAM.md");

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repositoryRoot,
    encoding: "utf8",
    // S4036: resolve "git" only in fixed, system-owned directories.
    env: { ...process.env, PATH: "/usr/local/bin:/usr/bin:/bin" },
  }).trim();
}

const head = git("rev-parse", "HEAD");
const parent = git("rev-parse", "HEAD^");
const branch = git("branch", "--show-current");
const status = git("status", "--short", "--untracked-files=all");
const ledger = readFileSync(ledgerPath, "utf8");
const exactMarker = `\`HEAD\` = \`${head}\``;
const parentPinnedMarker = `P1 marker parent = \`${parent}\``;
const latestParentPinnedMarker = `Latest state marker parent = \`${parent}\``;

if (
  !ledger.includes("## Correção de estado M-02") ||
  (!ledger.includes(exactMarker) &&
    !ledger.includes(parentPinnedMarker) &&
    !ledger.includes(latestParentPinnedMarker))
) {
  console.error(
    `Ledger M-02 desatualizado: registre HEAD ${head} ou o parent-pinned marker ${parent} antes de prosseguir.`,
  );
  process.exitCode = 1;
} else {
  const markerKind = ledger.includes(exactMarker)
    ? "exact"
    : ledger.includes(latestParentPinnedMarker)
      ? "latest parent-pinned"
      : "parent-pinned";
  console.log(`M-02 ${markerKind} state marker is valid for HEAD ${head} on ${branch}.`);
}

console.log(`Worktree: ${status ? "dirty (preservado e auditável)" : "clean"}.`);
console.log("External state: not inspected by this local check.");
