import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  buildRepairPlan,
  buildRepairSql,
  grantStatement,
  planCanApply,
  type GrantRecord,
  type RoleDescriptor,
  writeArtifacts,
} from "../../scripts/db/grant-repair";

const tempDirectories: string[] = [];

afterEach(() => {
  for (const directory of tempDirectories.splice(0))
    rmSync(directory, { recursive: true, force: true });
});

function grant(
  table: string,
  grantee: string,
  privilege: string,
  isGrantable: "YES" | "NO" = "NO",
): GrantRecord {
  return {
    kind: "grant",
    schema: "public",
    name: `${table}.${grantee}.${privilege}`,
    definition: {
      grantee,
      grantor: "neondb_owner",
      table_name: table,
      is_grantable: isGrantable,
      table_schema: "public",
      table_catalog: "neondb",
      privilege_type: privilege,
      with_hierarchy: "NO",
    },
  };
}

const roles: RoleDescriptor[] = [
  {
    rolname: "app_runtime",
    rolsuper: false,
    rolinherit: false,
    rolcreaterole: false,
    rolcreatedb: false,
    rolcanlogin: true,
    rolreplication: false,
    rolbypassrls: false,
  },
  {
    rolname: "neondb_owner",
    rolsuper: false,
    rolinherit: true,
    rolcreaterole: true,
    rolcreatedb: true,
    rolcanlogin: true,
    rolreplication: true,
    rolbypassrls: true,
  },
];

describe("grant repair plan", () => {
  it("derives missing grants from the collector and requires roles first", () => {
    const source = [
      grant("accounts", "app_runtime", "SELECT"),
      grant("products", "app_runtime", "UPDATE"),
    ];
    const target = [source[0]];
    const plan = buildRepairPlan(source, target, roles, roles);

    expect(plan.missingGrants).toHaveLength(1);
    expect(plan.missingGrants[0]?.definition.table_name).toBe("products");
    expect(plan.requiredRoles).toEqual(["app_runtime", "neondb_owner"]);
    expect(planCanApply(plan, false)).toBe(true);
    expect(buildRepairSql(plan, false)).toMatch(/roles-before|grant_repair_roles|GRANT UPDATE/);
  });

  it("quotes catalog identifiers and preserves grant option", () => {
    const statement = grantStatement(grant('table"name', "role'name", "SELECT", "YES"));
    expect(statement).toBe(
      'GRANT SELECT ON TABLE "public"."table""name" TO "role\'name" WITH GRANT OPTION;',
    );
  });

  it("blocks extra and mismatched grants instead of revoking or guessing", () => {
    const source = [grant("accounts", "app_runtime", "SELECT")];
    const target = [grant("accounts", "app_runtime", "SELECT", "YES")];
    const plan = buildRepairPlan(source, target, roles, roles);

    expect(plan.mismatchedGrants).toHaveLength(1);
    expect(plan.extraGrants).toHaveLength(0);
    expect(plan.missingGrants).toHaveLength(0);
    expect(planCanApply(plan, false)).toBe(false);
  });

  it("reports a missing LOGIN role as external provisioning, not auto-create", () => {
    const source = [grant("accounts", "app_runtime", "SELECT")];
    const plan = buildRepairPlan(source, [], roles, []);

    expect(plan.missingRoles).toEqual(["app_runtime", "neondb_owner"]);
    expect(plan.externalRoleProvisioning.map((role) => role.rolname)).toEqual([
      "app_runtime",
      "neondb_owner",
    ]);
    expect(planCanApply(plan, true)).toBe(false);
  });

  it("writes a reproducible SQL/JSON/Markdown trio into a tmpdir", () => {
    const directory = mkdtempSync(join(tmpdir(), "m02-grant-repair-"));
    tempDirectories.push(directory);
    const sql =
      '-- roles-before-grants\nGRANT SELECT ON TABLE "public"."accounts" TO "app_runtime";\n';
    const paths = { markdown: join(directory, "repair.md") };
    writeArtifacts(
      paths.markdown,
      {
        finished_at: "2026-09-07T00:00:00Z",
        source_branch: "br-source",
        target_branch: "br-target",
        target_kind: "drill-branch",
        apply: false,
        result: "DRY_RUN",
        target_current_role: "neondb_owner",
        roles: { required: ["app_runtime"], missing: [], mismatched: [] },
        plan: { source: 1, target_before: 0, missing: 1, extra: 0, mismatched: 0 },
        sql_statements: 2,
        sql_sha256: "test",
        after_comparison: null,
      },
      '-- roles-before-grants\nGRANT SELECT ON TABLE "public"."accounts" TO "app_runtime";\n',
    );
    const jsonPath = join(directory, "repair.json");
    const sqlPath = join(directory, "repair.sql");

    expect(readFileSync(sqlPath, "utf8")).toContain("roles-before-grants");
    expect(JSON.parse(readFileSync(jsonPath, "utf8")).result).toBe("DRY_RUN");
    expect(readFileSync(paths.markdown, "utf8")).toContain("DRY_RUN");
    expect(readFileSync(sqlPath, "utf8")).toContain("roles-before-grants");
  });
});
