import { describe, expect, it } from "vitest";
import {
  assertPurgeAllowed,
  buildDeleteSteps,
  FIXTURE_EMAIL_DOMAIN,
  isFixtureEmail,
  TENANT_SCOPED_TABLES,
  type PurgePlan,
} from "../../scripts/db/purge-fixtures";

const plan = (over: Partial<PurgePlan> = {}): PurgePlan => ({
  fixtureUsers: [{ id: "u1", email: `qa${FIXTURE_EMAIL_DOMAIN}` }],
  fixtureTenantIds: ["t1"],
  nonFixtureUserCount: 0,
  ...over,
});

describe("purge-fixtures boundaries", () => {
  it("reconhece apenas o domínio de fixture, sem sensibilidade a caixa/espaços", () => {
    expect(isFixtureEmail(`QA.Local.Admin${FIXTURE_EMAIL_DOMAIN}`)).toBe(true);
    expect(isFixtureEmail(" real@preco-que-da.com ")).toBe(false);
    expect(isFixtureEmail("")).toBe(false);
  });
  it("fail-closed: qualquer usuário fora do marcador aborta", () => {
    expect(() => assertPurgeAllowed(plan({ nonFixtureUserCount: 1 }))).toThrow(/ABORTADO/);
    expect(() =>
      assertPurgeAllowed(plan({ fixtureUsers: [{ id: "u2", email: "real@exemplo.com" }] })),
    ).toThrow(/ABORTADO/);
    expect(() => assertPurgeAllowed(plan())).not.toThrow();
  });
  it("plano de deletes é FK-safe: filhos tenant-scoped primeiro, usuários por último", () => {
    const labels = buildDeleteSteps().map((step) => step.label);
    expect(labels.slice(0, TENANT_SCOPED_TABLES.length)).toEqual([...TENANT_SCOPED_TABLES]);
    expect(labels.indexOf("chat_messages")).toBeLessThan(labels.indexOf("chat_conversations"));
    expect(labels.indexOf("tenant_memberships")).toBeLessThan(labels.indexOf("tenants"));
    expect(labels.indexOf("sessions")).toBeLessThan(labels.indexOf("users"));
    expect(labels.indexOf("accounts")).toBeLessThan(labels.indexOf("users"));
    expect(labels.at(-2)).toBe("users");
    expect(labels.at(-1)).toBe("rate_limits");
  });
  it("toda tabela do plano é nome literal fixo (sem input externo)", () => {
    for (const step of buildDeleteSteps()) {
      expect(step.sql).not.toMatch(/\$\d.*from/i);
      expect(step.label).toMatch(/^[a-z_]+$/);
    }
  });
});
