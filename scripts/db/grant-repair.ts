import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { type PoolClient } from "pg";
import { compareInventories, directPool, inventory, type Inventory } from "./backup-verify.ts";

const PRODUCTION_ENDPOINT_PREFIX = "ep-long-violet-aye9g0bn";
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PRIVILEGES = new Set([
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "TRUNCATE",
  "REFERENCES",
  "TRIGGER",
]);
const ROLE_ATTRIBUTES = [
  "rolsuper",
  "rolinherit",
  "rolcreaterole",
  "rolcreatedb",
  "rolcanlogin",
  "rolreplication",
  "rolbypassrls",
] as const;

export interface GrantDefinition {
  grantee: string;
  grantor: string;
  table_name: string;
  is_grantable: "YES" | "NO";
  table_schema: string;
  table_catalog: string;
  privilege_type: string;
  with_hierarchy: string;
}

export interface GrantRecord {
  kind: "grant";
  schema: string;
  name: string;
  definition: GrantDefinition;
}

export interface RoleDescriptor {
  rolname: string;
  rolsuper: boolean;
  rolinherit: boolean;
  rolcreaterole: boolean;
  rolcreatedb: boolean;
  rolcanlogin: boolean;
  rolreplication: boolean;
  rolbypassrls: boolean;
}

export interface GrantMismatch {
  identity: string;
  source: GrantRecord;
  target: GrantRecord;
}

export interface GrantRepairPlan {
  sourceGrants: GrantRecord[];
  targetGrants: GrantRecord[];
  missingGrants: GrantRecord[];
  extraGrants: GrantRecord[];
  mismatchedGrants: GrantMismatch[];
  requiredRoles: string[];
  sourceRoles: RoleDescriptor[];
  targetRoles: RoleDescriptor[];
  sourceMissingRoles: string[];
  missingRoles: string[];
  mismatchedRoles: string[];
  safeGroupRoles: RoleDescriptor[];
  externalRoleProvisioning: RoleDescriptor[];
}

export interface GrantRepairArgs {
  sourceEnv: string;
  targetEnv: string;
  sourceBranch: string;
  targetBranch: string;
  targetKind: "drill-branch";
  out?: string;
  apply: boolean;
  createMissingGroupRoles: boolean;
}

type RecordValue = Record<string, unknown>;

interface RepairContext {
  sourceRaw: string;
  targetRaw: string;
  motivo: string | null;
  startedAt: string;
  sourcePool: ReturnType<typeof directPool>;
  targetPool: ReturnType<typeof directPool>;
}

interface RepairState {
  sourceInventory: Inventory;
  targetInventory: Inventory;
  plan: GrantRepairPlan;
  targetCurrentRole: string;
}

type InventoryComparison = ReturnType<typeof compareInventories>;

function isRecord(value: unknown): value is RecordValue {
  return typeof value === "object" && value !== null;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`invalid grant catalog field: ${field}`);
  }
  return value;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function safeRoleDescriptor(value: unknown): RoleDescriptor {
  if (!isRecord(value)) throw new Error("invalid role catalog row");
  const descriptor = {
    rolname: requiredString(value.rolname, "rolname"),
    rolsuper: value.rolsuper === true,
    rolinherit: value.rolinherit === true,
    rolcreaterole: value.rolcreaterole === true,
    rolcreatedb: value.rolcreatedb === true,
    rolcanlogin: value.rolcanlogin === true,
    rolreplication: value.rolreplication === true,
    rolbypassrls: value.rolbypassrls === true,
  } satisfies RoleDescriptor;
  return descriptor;
}

export function extractGrantRows(catalog: unknown[]): GrantRecord[] {
  return catalog
    .filter((row) => isRecord(row) && row.kind === "grant")
    .map((row) => {
      if (!isRecord(row) || !isRecord(row.definition)) throw new Error("invalid grant catalog row");
      const definition = row.definition;
      const isGrantable = requiredString(definition.is_grantable, "is_grantable");
      if (isGrantable !== "YES" && isGrantable !== "NO") {
        throw new Error("invalid grant catalog field: is_grantable");
      }
      return {
        kind: "grant",
        schema: requiredString(row.schema, "schema"),
        name: requiredString(row.name, "name"),
        definition: {
          grantee: requiredString(definition.grantee, "grantee"),
          grantor: requiredString(definition.grantor, "grantor"),
          table_name: requiredString(definition.table_name, "table_name"),
          is_grantable: isGrantable,
          table_schema: requiredString(definition.table_schema, "table_schema"),
          table_catalog: requiredString(definition.table_catalog, "table_catalog"),
          privilege_type: requiredString(definition.privilege_type, "privilege_type"),
          with_hierarchy: requiredString(definition.with_hierarchy, "with_hierarchy"),
        },
      } satisfies GrantRecord;
    })
    .sort((left, right) => grantKey(left).localeCompare(grantKey(right)));
}

export function grantIdentity(grant: GrantRecord): string {
  const definition = grant.definition;
  return [
    definition.table_schema,
    definition.table_name,
    definition.grantee,
    definition.privilege_type,
  ].join("\u001f");
}

export function grantKey(grant: GrantRecord): string {
  return JSON.stringify([grant.schema, grant.name, grant.definition]);
}

function indexGrants(grants: GrantRecord[]): Map<string, GrantRecord> {
  const indexed = new Map<string, GrantRecord>();
  for (const grant of grants) {
    const identity = grantIdentity(grant);
    if (indexed.has(identity)) throw new Error(`duplicate grant identity: ${identity}`);
    indexed.set(identity, grant);
  }
  return indexed;
}

function requiredRoleNames(catalog: unknown[], grants: GrantRecord[]): string[] {
  const names = new Set<string>();
  for (const grant of grants) {
    names.add(grant.definition.grantee);
    names.add(grant.definition.grantor);
  }
  for (const row of catalog) {
    if (!isRecord(row) || row.kind !== "table" || !isRecord(row.definition)) continue;
    const owner = row.definition.owner;
    if (typeof owner === "string" && owner.trim() !== "") names.add(owner);
  }
  return [...names].sort((left, right) => left.localeCompare(right));
}

function sameRoleAttributes(left: RoleDescriptor, right: RoleDescriptor): boolean {
  return ROLE_ATTRIBUTES.every((attribute) => left[attribute] === right[attribute]);
}

function isSafeMissingGroupRole(role: RoleDescriptor): boolean {
  return (
    !role.rolcanlogin &&
    !role.rolsuper &&
    !role.rolcreaterole &&
    !role.rolcreatedb &&
    !role.rolreplication &&
    !role.rolbypassrls
  );
}

export function buildRepairPlan(
  sourceCatalog: unknown[],
  targetCatalog: unknown[],
  sourceRoleRows: unknown[],
  targetRoleRows: unknown[],
): GrantRepairPlan {
  const sourceGrants = extractGrantRows(sourceCatalog);
  const targetGrants = extractGrantRows(targetCatalog);
  const sourceByIdentity = indexGrants(sourceGrants);
  const targetByIdentity = indexGrants(targetGrants);
  const requiredRoles = requiredRoleNames(sourceCatalog, sourceGrants);
  const sourceRoles = sourceRoleRows
    .map(safeRoleDescriptor)
    .sort((a, b) => a.rolname.localeCompare(b.rolname));
  const targetRoles = targetRoleRows
    .map(safeRoleDescriptor)
    .sort((a, b) => a.rolname.localeCompare(b.rolname));
  const sourceRoleByName = new Map(sourceRoles.map((role) => [role.rolname, role]));
  const targetRoleByName = new Map(targetRoles.map((role) => [role.rolname, role]));

  const missingGrants: GrantRecord[] = [];
  const mismatchedGrants: GrantMismatch[] = [];
  for (const [identity, source] of sourceByIdentity) {
    const target = targetByIdentity.get(identity);
    if (!target) missingGrants.push(source);
    else if (grantKey(source) !== grantKey(target))
      mismatchedGrants.push({ identity, source, target });
  }
  const extraGrants = [...targetByIdentity.entries()]
    .filter(([identity]) => !sourceByIdentity.has(identity))
    .map(([, grant]) => grant)
    .sort((a, b) => grantKey(a).localeCompare(grantKey(b)));
  const missingRoles = requiredRoles.filter((role) => !targetRoleByName.has(role));
  const sourceMissingRoles = requiredRoles.filter((role) => !sourceRoleByName.has(role));
  const mismatchedRoles = requiredRoles.filter((role) => {
    const source = sourceRoleByName.get(role);
    const target = targetRoleByName.get(role);
    return source !== undefined && target !== undefined && !sameRoleAttributes(source, target);
  });
  const safeGroupRoles = missingRoles
    .map((role) => sourceRoleByName.get(role))
    .filter((role): role is RoleDescriptor => role !== undefined && isSafeMissingGroupRole(role));
  const externalRoleProvisioning = missingRoles
    .map((role) => sourceRoleByName.get(role))
    .filter((role): role is RoleDescriptor => role !== undefined && !isSafeMissingGroupRole(role));

  return {
    sourceGrants,
    targetGrants,
    missingGrants: missingGrants.sort((a, b) => grantKey(a).localeCompare(grantKey(b))),
    extraGrants,
    mismatchedGrants: mismatchedGrants.sort((a, b) => a.identity.localeCompare(b.identity)),
    requiredRoles,
    sourceRoles,
    targetRoles,
    sourceMissingRoles,
    missingRoles,
    mismatchedRoles,
    safeGroupRoles,
    externalRoleProvisioning,
  };
}

export function planCanApply(plan: GrantRepairPlan, createMissingGroupRoles: boolean): boolean {
  if (plan.sourceMissingRoles.length || plan.mismatchedRoles.length) return false;
  if (plan.extraGrants.length || plan.mismatchedGrants.length) return false;
  if (plan.externalRoleProvisioning.length) return false;
  return plan.missingRoles.length === 0 || createMissingGroupRoles;
}

function createGroupRoleStatement(role: RoleDescriptor): string {
  if (!isSafeMissingGroupRole(role))
    throw new Error(`unsafe role cannot be auto-created: ${role.rolname}`);
  return [
    `CREATE ROLE ${quoteIdentifier(role.rolname)}`,
    "NOLOGIN",
    role.rolinherit ? "INHERIT" : "NOINHERIT",
    "NOSUPERUSER",
    "NOCREATEDB",
    "NOCREATEROLE",
    "NOREPLICATION",
    "NOBYPASSRLS;",
  ].join(" ");
}

export function grantStatement(grant: GrantRecord): string {
  const privilege = grant.definition.privilege_type.toUpperCase();
  if (!PRIVILEGES.has(privilege)) throw new Error(`unsupported table privilege: ${privilege}`);
  const option = grant.definition.is_grantable === "YES" ? " WITH GRANT OPTION" : "";
  return `GRANT ${privilege} ON TABLE ${quoteIdentifier(grant.definition.table_schema)}.${quoteIdentifier(grant.definition.table_name)} TO ${quoteIdentifier(grant.definition.grantee)}${option};`;
}

function rolesBeforeGrantsStatement(roleNames: string[]): string {
  if (roleNames.length === 0) throw new Error("grant repair requires at least one role");
  const values = roleNames.map((role) => `(${quoteLiteral(role)})`).join(", ");
  return `DO $grant_repair_roles$\nDECLARE\n  missing text;\nBEGIN\n  SELECT string_agg(required_role, ', ' ORDER BY required_role)\n    INTO missing\n    FROM (VALUES ${values}) AS required(required_role)\n   WHERE NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = required.required_role);\n  IF missing IS NOT NULL THEN\n    RAISE EXCEPTION 'grant repair requires roles before grants: %', missing;\n  END IF;\nEND\n$grant_repair_roles$;`;
}

export function buildRepairStatements(
  plan: GrantRepairPlan,
  createMissingGroupRoles: boolean,
): string[] {
  if (!planCanApply(plan, createMissingGroupRoles)) {
    throw new Error("grant repair plan is blocked by role or catalog differences");
  }
  const statements = createMissingGroupRoles
    ? plan.safeGroupRoles.map(createGroupRoleStatement)
    : [];
  statements.push(rolesBeforeGrantsStatement(plan.requiredRoles));
  statements.push(...plan.missingGrants.map(grantStatement));
  return statements;
}

export function buildRepairSql(plan: GrantRepairPlan, createMissingGroupRoles: boolean): string {
  return `${buildRepairStatements(plan, createMissingGroupRoles).join("\n\n")}\n`;
}

async function roleRows(client: PoolClient, roleNames: string[]): Promise<RoleDescriptor[]> {
  if (roleNames.length === 0) return [];
  const result = await client.query<RoleDescriptor>(
    `SELECT rolname, rolsuper, rolinherit, rolcreaterole, rolcreatedb, rolcanlogin,
            rolreplication, rolbypassrls
       FROM pg_roles
      WHERE rolname = ANY($1::name[])
      ORDER BY rolname`,
    [roleNames],
  );
  return result.rows;
}

async function currentUser(client: PoolClient): Promise<string> {
  const result = await client.query<{ current_user: string }>("SELECT current_user");
  return result.rows[0].current_user;
}

async function applyStatements(client: PoolClient, statements: string[]): Promise<void> {
  await client.query("BEGIN");
  try {
    for (const statement of statements) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  }
}

function parseCli(argv: string[]): GrantRepairArgs | { error: string } {
  try {
    const { values } = parseArgs({
      args: argv,
      options: {
        "source-env": { type: "string" },
        "target-env": { type: "string" },
        "source-branch": { type: "string" },
        "target-branch": { type: "string" },
        "target-kind": { type: "string" },
        out: { type: "string" },
        apply: { type: "boolean", default: false },
        "create-missing-group-roles": { type: "boolean", default: false },
      },
      strict: true,
    });
    const sourceEnv = values["source-env"];
    const targetEnv = values["target-env"];
    const sourceBranch = values["source-branch"];
    const targetBranch = values["target-branch"];
    const targetKind = values["target-kind"];
    if (
      typeof sourceEnv !== "string" ||
      typeof targetEnv !== "string" ||
      typeof sourceBranch !== "string" ||
      typeof targetBranch !== "string" ||
      typeof targetKind !== "string" ||
      [sourceEnv, targetEnv, sourceBranch, targetBranch, targetKind].some(
        (value) => value.trim() === "",
      )
    ) {
      return { error: "source/target env, branches e target-kind sao obrigatorios" };
    }
    if (!ENV_NAME.test(sourceEnv) || !ENV_NAME.test(targetEnv)) {
      return { error: "source-env e target-env devem ser nomes de variaveis" };
    }
    if (sourceEnv === targetEnv || sourceBranch === targetBranch) {
      return { error: "origem e alvo devem ser distintos" };
    }
    if (targetKind !== "drill-branch") return { error: "target-kind deve ser drill-branch" };
    if (values["create-missing-group-roles"] && !values.apply) {
      return { error: "create-missing-group-roles exige --apply" };
    }
    if (values.out && !values.out.endsWith(".md")) return { error: "--out deve apontar para .md" };
    if (values.apply && !values.out) return { error: "--apply exige --out para evidencia" };
    return {
      sourceEnv,
      targetEnv,
      sourceBranch,
      targetBranch,
      targetKind,
      out: values.out,
      apply: values.apply,
      createMissingGroupRoles: values["create-missing-group-roles"] ?? false,
    };
  } catch {
    return { error: "argumentos invalidos; valores de URL nunca sao aceitos em argv" };
  }
}

function localHost(host: string): boolean {
  return host === "127.0.0.1" || host === "localhost" || host === "::1";
}

function validateConnectionUrl(raw: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(`${label} URL malformada`);
  }
  if (!["postgres:", "postgresql:"].includes(parsed.protocol)) {
    throw new Error(`${label} exige URL PostgreSQL direct`);
  }
  const host = parsed.hostname.toLowerCase();
  if (host.includes("-pooler")) throw new Error(`${label} exige endpoint direct`);
  return parsed;
}

function maskError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.includes("://")
    ? "erro de conexao/banco (detalhes omitidos)"
    : message.slice(0, 200);
}

function reportMarkdown(payload: RecordValue): string {
  const plan = payload.plan as RecordValue;
  const roles = payload.roles as RecordValue;
  return [
    `# Grant repair - ${payload.finished_at}`,
    "",
    `- source branch: \`${payload.source_branch}\` · target branch: \`${payload.target_branch}\` · target-kind: \`${payload.target_kind}\``,
    `- modo: ${payload.apply ? "APPLY em branch efemera" : "DRY-RUN (nenhuma escrita)"} | read-only source: true`,
    `- motivo: ${payload.motivo ?? "ausente/local"}`,
    `- resultado: **${payload.result}** | current role do alvo: \`${payload.target_current_role ?? "omitido"}\``,
    `- roles requeridas antes de grants: ${JSON.stringify(roles.required)}`,
    `- roles ausentes no alvo: ${JSON.stringify(roles.missing)} · mismatches: ${JSON.stringify(roles.mismatched)}`,
    `- grants: source=${plan.source} | target_before=${plan.target_before} | missing=${plan.missing} | extra=${plan.extra} | mismatched=${plan.mismatched}`,
    `- statements: ${payload.sql_statements} · sha256 SQL: \`${payload.sql_sha256}\``,
    `- comparacao apos reparo: ${JSON.stringify(payload.after_comparison ?? null)}`,
    "",
    "O artefato nunca cria senha, owner privilegiado ou role LOGIN ausente; roles LOGIN/privileged faltantes exigem provisionamento externo antes dos grants.",
    "",
  ].join("\n");
}

export function writeArtifacts(out: string, payload: RecordValue, sql: string): void {
  const outPath = resolve(out);
  const sqlPath = outPath.replace(/\.md$/, ".sql");
  const jsonPath = outPath.replace(/\.md$/, ".json");
  if (existsSync(outPath) || existsSync(sqlPath) || existsSync(jsonPath)) {
    throw new Error("destino de evidencia ja existe; fail-closed, sem sobrescrita");
  }
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(sqlPath, sql, "utf8");
  writeFileSync(jsonPath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  writeFileSync(outPath, reportMarkdown(payload), "utf8");
}

function planSummary(plan: GrantRepairPlan): RecordValue {
  return {
    source: plan.sourceGrants.length,
    target_before: plan.targetGrants.length,
    missing: plan.missingGrants.length,
    extra: plan.extraGrants.length,
    mismatched: plan.mismatchedGrants.length,
  };
}

function prepareRepair(parsed: GrantRepairArgs) {
  const sourceRaw = process.env[parsed.sourceEnv];
  const targetRaw = process.env[parsed.targetEnv];
  if (!sourceRaw || !targetRaw) throw new Error("source/target connection env ausente");
  const sourceUrl = validateConnectionUrl(sourceRaw.trim(), "source");
  const targetUrl = validateConnectionUrl(targetRaw.trim(), "target");
  const sourceHost = sourceUrl.hostname.toLowerCase();
  const targetHost = targetUrl.hostname.toLowerCase();
  const motivo = process.env.ALLOW_REMOTE_DB?.trim() || null;
  if (sourceHost === targetHost) throw new Error("source e target exigem endpoints distintos");
  if (targetHost.includes(PRODUCTION_ENDPOINT_PREFIX))
    throw new Error("target production proibido");
  if ((!localHost(sourceHost) || !localHost(targetHost)) && !motivo) {
    throw new Error("target remoto exige ALLOW_REMOTE_DB com motivo");
  }
  if (motivo?.includes("://")) throw new Error("motivo nao pode conter URL");
  return {
    sourceRaw,
    targetRaw,
    motivo,
    startedAt: new Date().toISOString(),
    sourcePool: directPool(sourceRaw.trim()),
    targetPool: directPool(targetRaw.trim()),
  };
}

function assertInventoryIdentity(
  parsed: GrantRepairArgs,
  sourceInventory: Inventory,
  targetInventory: Inventory,
): void {
  if (
    sourceInventory.identity?.branch_id !== parsed.sourceBranch ||
    targetInventory.identity?.branch_id !== parsed.targetBranch ||
    sourceInventory.identity?.project_id !== targetInventory.identity?.project_id
  ) {
    throw new Error("server target identity mismatch");
  }
}

async function loadRepairState(
  parsed: GrantRepairArgs,
  sourceClient: PoolClient,
  targetClient: PoolClient,
): Promise<RepairState> {
  const sourceInventory = await inventory(sourceClient);
  const targetInventory = await inventory(targetClient);
  assertInventoryIdentity(parsed, sourceInventory, targetInventory);
  const roles = requiredRoleNames(
    sourceInventory.catalog,
    extractGrantRows(sourceInventory.catalog),
  );
  const [sourceRoles, targetRoles] = await Promise.all([
    roleRows(sourceClient, roles),
    roleRows(targetClient, roles),
  ]);
  const plan = buildRepairPlan(
    sourceInventory.catalog,
    targetInventory.catalog,
    sourceRoles,
    targetRoles,
  );
  const targetCurrentRole = await currentUser(targetClient);
  const grantors = new Set(plan.sourceGrants.map((grant) => grant.definition.grantor));
  if (grantors.size !== 1 || !grantors.has(targetCurrentRole)) {
    throw new Error("target role nao corresponde ao grantor da origem");
  }
  return { sourceInventory, targetInventory, plan, targetCurrentRole };
}

function resultForRepair(
  parsed: GrantRepairArgs,
  canApply: boolean,
  afterComparison: InventoryComparison | null,
): string {
  if (!canApply) return "BLOCKED";
  if (!parsed.apply) return "DRY_RUN";
  return afterComparison?.pass ? "PASS" : "FAIL";
}

function buildRepairPayload(
  parsed: GrantRepairArgs,
  context: RepairContext,
  state: RepairState,
  result: string,
  afterComparison: InventoryComparison | null,
  repairStatements: string[],
  sql: string,
): RecordValue {
  const { plan, targetCurrentRole } = state;
  return {
    check: "m02:grant-repair",
    version: 1,
    read_only_source: true,
    target_write: parsed.apply && result !== "BLOCKED",
    started_at: context.startedAt,
    finished_at: new Date().toISOString(),
    source_branch: parsed.sourceBranch,
    target_branch: parsed.targetBranch,
    target_kind: parsed.targetKind,
    apply: parsed.apply,
    motivo: context.motivo,
    create_missing_group_roles: parsed.createMissingGroupRoles,
    target_current_role: targetCurrentRole,
    result,
    roles: {
      required: plan.requiredRoles,
      source: plan.sourceRoles.map((role) => role.rolname),
      target_before: plan.targetRoles.map((role) => role.rolname),
      missing: plan.missingRoles,
      source_missing: plan.sourceMissingRoles,
      mismatched: plan.mismatchedRoles,
      safe_group_roles: plan.safeGroupRoles.map((role) => role.rolname),
      external_provisioning: plan.externalRoleProvisioning.map((role) => role.rolname),
      order: "roles-before-grants",
    },
    plan: planSummary(plan),
    after_comparison: afterComparison,
    sql_statements: repairStatements.length,
    sql_sha256: createHash("sha256").update(sql).digest("hex"),
    limits:
      "Somente a branch target drill-branch pode receber writes; nenhuma senha, URL, row content ou role privileged e criada. Roles ausentes LOGIN/privileged exigem provisionamento externo antes de grants.",
  };
}

async function calculateRepair(
  parsed: GrantRepairArgs,
  context: RepairContext,
  state: RepairState,
  targetClient: PoolClient,
) {
  const { sourceInventory, plan } = state;
  const canApply = planCanApply(plan, parsed.createMissingGroupRoles);
  const repairStatements = canApply
    ? buildRepairStatements(plan, parsed.createMissingGroupRoles)
    : [];
  let sql = canApply ? `${repairStatements.join("\n\n")}\n` : "";
  let afterComparison = null;
  if (parsed.apply && canApply) {
    await applyStatements(targetClient, repairStatements);
    const afterInventory = await inventory(targetClient);
    afterComparison = compareInventories(sourceInventory, afterInventory);
  }
  const result = resultForRepair(parsed, canApply, afterComparison);
  if (!sql && canApply) sql = `${rolesBeforeGrantsStatement(plan.requiredRoles)}\n`;
  const payload = buildRepairPayload(
    parsed,
    context,
    state,
    result,
    afterComparison,
    repairStatements,
    sql,
  );
  return { payload, sql, result };
}

async function executeRepair(parsed: GrantRepairArgs, context: RepairContext): Promise<void> {
  let sourceClient: PoolClient | undefined;
  let targetClient: PoolClient | undefined;
  try {
    sourceClient = await context.sourcePool.connect();
    targetClient = await context.targetPool.connect();
    const state = await loadRepairState(parsed, sourceClient!, targetClient!);
    const { payload, sql, result } = await calculateRepair(parsed, context, state, targetClient!);
    if (parsed.out) writeArtifacts(parsed.out, payload, sql);
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    process.exitCode = result === "PASS" || result === "DRY_RUN" ? 0 : 1;
  } finally {
    sourceClient?.release();
    targetClient?.release();
    await context.sourcePool.end();
    await context.targetPool.end();
  }
}

async function main(): Promise<void> {
  const parsed = parseCli(process.argv.slice(2));
  if ("error" in parsed) {
    process.stderr.write(`m02:grant-repair: ${parsed.error}\n`);
    process.exitCode = 2;
    return;
  }
  const context = prepareRepair(parsed);
  await executeRepair(parsed, context);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch((error) => {
    process.stderr.write(
      `${JSON.stringify({ check: "m02:grant-repair", result: "ERROR", error: maskError(error) })}\n`,
    );
    process.exitCode = 2;
  });
}
