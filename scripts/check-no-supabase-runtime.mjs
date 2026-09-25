import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";

function filesUnder(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? filesUnder(child) : [child];
  });
}

const executableFiles = [
  ...filesUnder("src"),
  ...filesUnder("scripts").filter(
    (file) =>
      !file.endsWith("scripts/check-no-supabase-runtime.mjs") &&
      !file.startsWith("scripts/migration/"),
  ),
  ...filesUnder(".github/workflows"),
  "package.json",
  "package-lock.json",
  ".env.example",
  "vite.config.ts",
  "drizzle.config.ts",
];

const forbidden = [
  /@supabase\//i,
  /@lovable\.dev\/cloud-auth-js/i,
  /integrations\/supabase/i,
  /\bVITE_SUPABASE_[A-Z0-9_]+\b/,
  /\bSUPABASE_(?!MIGRATION_DATABASE_URL)[A-Z0-9_]+\b/,
  /\bsupabase\.(?:from|auth)\b/i,
  /(?:localStorage|sessionStorage)[\s\S]{0,120}(?:token|session)/i,
  /(?:token|session)[\s\S]{0,120}(?:localStorage|sessionStorage)/i,
];

const findings = [];
for (const file of executableFiles) {
  const source = readFileSync(resolve(file), "utf8");
  for (const pattern of forbidden) {
    if (pattern.test(`${file}\n${source}`)) findings.push(`${file}: ${pattern}`);
  }
}

if (findings.length) {
  console.error("Dependência Supabase/Auth legada encontrada no runtime:");
  for (const finding of findings) console.error(`- ${finding}`);
  process.exit(1);
}

console.log("Gate de cutover: runtime sem Supabase e sem token em Web Storage.");
