import { describe, expect, it } from "vitest";
import { assertTenantMutationAuthorized } from "@/lib/request-context";

describe("tenant mutation authorization", () => {
  it("permite owner e admin", () => {
    expect(() => assertTenantMutationAuthorized({ roles: ["owner"] })).not.toThrow();
    expect(() => assertTenantMutationAuthorized({ roles: ["admin"] })).not.toThrow();
  });

  it("nega member sem privilégio de escrita", () => {
    expect(() => assertTenantMutationAuthorized({ roles: ["member"] })).toThrowError(
      "Você não pode realizar esta ação.",
    );
    expect(() => assertTenantMutationAuthorized({ roles: [] })).toThrowError(
      "Você não pode realizar esta ação.",
    );
  });
});
