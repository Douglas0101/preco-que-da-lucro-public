import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const viteCli = path.join(root, "node_modules/vite/bin/vite.js");
const reportPath = path.join(root, ".artifacts/build-warnings.json");
const warningAllowlist = [
  {
    id: "WARN-NITRO-001",
    signature:
      "inlineDynamicImports option is ignored because the codeSplitting option is specified.",
    owner: "plataforma/frontend",
    releaseChannels: ["local", "pre-beta-internal"],
    expiresOn: "2026-10-06",
    recheckedAt: "2026-09-07",
  },
];

let stdout = "";
let stderr = "";
const child = spawn(process.execPath, [viteCli, "build"], {
  cwd: root,
  env: process.env,
  stdio: ["inherit", "pipe", "pipe"],
});

child.stdout.on("data", (chunk) => {
  stdout += chunk;
  process.stdout.write(chunk);
});
child.stderr.on("data", (chunk) => {
  stderr += chunk;
  process.stderr.write(chunk);
});

const exitCode = await new Promise((resolve, reject) => {
  child.once("error", reject);
  child.once("close", (code) => resolve(code ?? 1));
});

const stripAnsi = (value) => value.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const plainStdout = stripAnsi(stdout);
const plainStderr = stripAnsi(stderr);
const stderrLines = plainStderr
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(Boolean);
const stdoutWarningLines = plainStdout
  .split(/\r?\n/)
  .map((line) => line.trim())
  .filter(
    (line) =>
      /(^|\s)WARN(?:ING)?(?:\s|$)/i.test(line) ||
      line.includes("(!)") ||
      /\bdeprecated\b/i.test(line),
  );
const warningLines = [...new Set([...stderrLines, ...stdoutWarningLines])];
const today = new Date().toISOString().slice(0, 10);
const releaseChannel =
  process.env.BUILD_RELEASE_CHANNEL ?? (process.env.CI ? "unclassified-ci" : "local");
const observedWarnings = warningLines.map((line) => {
  const normalizedLine = line
    .replace(/^(?:\[(?:warn|warning)\]|WARN(?:ING)?|\(!\))\s*/i, "")
    .replaceAll("`", "")
    .trim();
  const exception = warningAllowlist.find(({ signature }) => normalizedLine === signature);
  const expired = exception ? today > exception.expiresOn : false;
  const releaseAllowed = exception?.releaseChannels.includes(releaseChannel) ?? false;
  return {
    line,
    exceptionId: exception?.id ?? null,
    expired,
    releaseAllowed,
    accepted: Boolean(exception) && !expired && releaseAllowed,
  };
});
const unexpectedWarnings = observedWarnings.filter(({ accepted }) => !accepted);
const passed = exitCode === 0 && unexpectedWarnings.length === 0;
const report = {
  schemaVersion: 1,
  commit: process.env.GITHUB_SHA ?? null,
  checkedAt: new Date().toISOString(),
  releaseChannel,
  exitCode,
  passed,
  allowlist: warningAllowlist,
  observedWarnings,
};

await mkdir(path.dirname(reportPath), { recursive: true });
await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`);

if (unexpectedWarnings.length > 0) {
  console.error("Build emitted unregistered or expired warnings:");
  for (const warning of unexpectedWarnings) console.error(`- ${warning.line}`);
}

if (!passed) process.exitCode = exitCode || 1;
