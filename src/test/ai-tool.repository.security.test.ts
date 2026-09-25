import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

function repositorySource(): string {
  return readFileSync(
    resolve(process.cwd(), "src/server/repositories/ai-tool.repository.ts"),
    "utf8",
  );
}

describe("isolamento cross-tenant do repositório de tools", () => {
  it("mantém tenant e usuário nos updates de conclusão e idempotência", () => {
    const source = repositorySource();
    const terminalMethods = source.slice(source.indexOf("async markSucceeded"));

    expect(terminalMethods).toContain("eq(toolExecutions.tenantId, context.tenantId)");
    expect(terminalMethods).toContain("eq(toolExecutions.userId, context.userId)");
    expect(terminalMethods).toContain("eq(idempotencyRecords.tenantId, context.tenantId)");
    expect(terminalMethods).toContain("eq(idempotencyRecords.userId, context.userId)");
  });
});
