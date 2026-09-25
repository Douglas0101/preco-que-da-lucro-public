import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { auditSecrets, envKeyNames } from "../../scripts/m02-secrets-audit";

const roots: string[] = [];
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "m02-audit-"));
  roots.push(root);
  return {
    root,
    put(path: string, content: string) {
      const full = join(root, path);
      mkdirSync(join(full, ".."), { recursive: true });
      writeFileSync(full, content);
    },
  };
}
afterEach(() => roots.splice(0).forEach((root) => rmSync(root, { recursive: true, force: true })));
describe("secrets audit boundaries", () => {
  it("parses only key names including export and whitespace", () => {
    expect(envKeyNames(" export TOKEN = secret\n# BAD=value\nX=other\n1BAD=value")).toEqual([
      "TOKEN",
      "X",
    ]);
  });
  it("covers nested env variants without exposing values or accepting substring consumers", () => {
    const { root, put } = fixture();
    put(".env.local", "TOKEN=never-print-this\nTOKEN2=another-secret");
    put("config/deploy.env", "ORPHAN=nested-secret");
    put("src/use.ts", "const value = process.env.TOKEN2");
    put("docs/guide.md", "TOKEN");
    const report = auditSecrets(root);
    expect(report.entries.find((e) => e.name === "TOKEN")?.classification).toBe("docs-only");
    expect(report.entries.find((e) => e.name === "TOKEN2")?.classification).toBe("consumer");
    expect(report.entries.find((e) => e.name === "ORPHAN")?.classification).toBe(
      "orphan-candidate",
    );
    for (const value of ["never-print-this", "another-secret", "nested-secret"])
      expect(JSON.stringify(report)).not.toContain(value);
  });
  it("does not promote evidence, tests, symlinks or env definitions to consumers", () => {
    const { root, put } = fixture();
    put(".env", "TOKEN=discard");
    put("docs/evidence/report.json", '{"TOKEN":"example"}');
    put("src/use.test.ts", "TOKEN");
    symlinkSync(join(root, ".env"), join(root, "linked.ts"));
    expect(auditSecrets(root).entries[0].classification).toBe("orphan-candidate");
  });
  it("fails closed on incomplete coverage and distinguishes CI metadata", () => {
    const { root, put } = fixture();
    put(".env", "TOKEN=discard");
    put("src/oversize.ts", "a".repeat(1024 * 1024 + 1));
    const report = auditSecrets(root, ["CI_ONLY"]);
    expect(report.result).toBe("INCOMPLETE");
    expect(report.entries.every((e) => e.classification === "unknown")).toBe(true);
    expect(auditSecrets(join(root, "absent")).coverage.failures).toHaveLength(1);
  });
});
