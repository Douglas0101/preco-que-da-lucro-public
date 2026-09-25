import { access, readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const issues = [];
const expectedUiFiles = [
  "alert-dialog.tsx",
  "badge.tsx",
  "button.tsx",
  "calc-explainer.tsx",
  "card.tsx",
  "input.tsx",
  "label.tsx",
  "select.tsx",
  "sheet.tsx",
  "skeleton.tsx",
  "sonner.tsx",
  "textarea.tsx",
];
const forbiddenPackages = [
  "@headlessui/react",
  "@radix-ui/react-accordion",
  "@radix-ui/react-alert-dialog",
  "@radix-ui/react-aspect-ratio",
  "@radix-ui/react-avatar",
  "@radix-ui/react-checkbox",
  "@radix-ui/react-collapsible",
  "@radix-ui/react-context-menu",
  "@radix-ui/react-dialog",
  "@radix-ui/react-dropdown-menu",
  "@radix-ui/react-hover-card",
  "@radix-ui/react-label",
  "@radix-ui/react-menubar",
  "@radix-ui/react-navigation-menu",
  "@radix-ui/react-popover",
  "@radix-ui/react-progress",
  "@radix-ui/react-radio-group",
  "@radix-ui/react-scroll-area",
  "@radix-ui/react-select",
  "@radix-ui/react-separator",
  "@radix-ui/react-slider",
  "@radix-ui/react-slot",
  "@radix-ui/react-switch",
  "@radix-ui/react-tabs",
  "@radix-ui/react-toggle",
  "@radix-ui/react-toggle-group",
  "@radix-ui/react-tooltip",
  "ariakit",
  "cmdk",
  "date-fns",
  "embla-carousel-react",
  "input-otp",
  "radix-ui",
  "react-aria-components",
  "react-day-picker",
  "react-resizable-panels",
  "recharts",
  "vaul",
];

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function collectFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(entryPath)));
    if (entry.isFile() && /\.(?:css|ts|tsx)$/.test(entry.name)) files.push(entryPath);
  }

  return files;
}

const packageJson = JSON.parse(await readFile(path.join(root, "package.json"), "utf8"));
const components = JSON.parse(await readFile(path.join(root, "components.json"), "utf8"));
const lock = JSON.parse(await readFile(path.join(root, "package-lock.json"), "utf8"));
const allDependencies = {
  ...packageJson.dependencies,
  ...packageJson.devDependencies,
};

if (components.style !== "base-nova") {
  issues.push(`components.json must use base-nova, found ${components.style}`);
}

if (!packageJson.packageManager?.startsWith("npm@")) {
  issues.push("package.json must pin npm in packageManager");
}

if (!("@base-ui/react" in (packageJson.dependencies ?? {}))) {
  issues.push("@base-ui/react must be a production dependency");
}

for (const dependency of Object.keys(allDependencies)) {
  if (dependency.startsWith("@radix-ui/") || forbiddenPackages.includes(dependency)) {
    issues.push(`forbidden dependency in package.json: ${dependency}`);
  }
}

for (const bunFile of ["bun.lock", "bunfig.toml"]) {
  if (await exists(path.join(root, bunFile))) issues.push(`${bunFile} must not exist`);
}

const uiFiles = (await readdir(path.join(root, "src/components/ui")))
  .filter((file) => file.endsWith(".tsx"))
  .sort();

if (JSON.stringify(uiFiles) !== JSON.stringify(expectedUiFiles)) {
  issues.push(`unexpected UI catalog: ${uiFiles.join(", ")}`);
}

const sourceFiles = await collectFiles(path.join(root, "src"));

for (const filePath of sourceFiles) {
  const relativePath = path.relative(root, filePath).split(path.sep).join("/");
  const source = await readFile(filePath, "utf8");
  const isUiWrapper = relativePath.startsWith("src/components/ui/");

  if (/@radix-ui|(?:from\s+["']radix-ui["'])|--radix-/.test(source)) {
    issues.push(`Radix residue in ${relativePath}`);
  }

  if (!isUiWrapper && /from\s+["']@base-ui\/react(?:\/[^"']*)?["']/.test(source)) {
    issues.push(`direct Base UI import outside wrappers: ${relativePath}`);
  }

  if (relativePath !== "src/components/ui/sonner.tsx" && /from\s+["']sonner["']/.test(source)) {
    issues.push(`direct Sonner import outside its wrapper: ${relativePath}`);
  }

  for (const match of source.matchAll(/from\s+["']@\/components\/ui\/([^"']+)["']/g)) {
    if (!expectedUiFiles.includes(`${match[1]}.tsx`)) {
      issues.push(`import outside the approved UI catalog in ${relativePath}: ${match[1]}`);
    }
  }

  const isApplicationComponent =
    relativePath.startsWith("src/routes/") ||
    (relativePath.startsWith("src/components/") && !isUiWrapper);

  if (isApplicationComponent && /<(?:button|input|select|textarea)\b/.test(source)) {
    issues.push(`raw interactive primitive in ${relativePath}`);
  }

  if (isApplicationComponent && /\b(?:window\.)?confirm\s*\(/.test(source)) {
    issues.push(`browser confirm in ${relativePath}`);
  }
}

for (const packagePath of Object.keys(lock.packages ?? {})) {
  if (
    packagePath.includes("node_modules/@radix-ui/") ||
    /(?:^|\/)node_modules\/(?:radix-ui|cmdk|vaul)$/.test(packagePath)
  ) {
    issues.push(`forbidden package-lock entry: ${packagePath}`);
  }
}

if (issues.length > 0) {
  console.error("UI stack check failed:\n" + issues.map((issue) => `- ${issue}`).join("\n"));
  process.exit(1);
}

console.log("UI stack check passed: shadcn/Base UI boundary and catalog are clean.");
