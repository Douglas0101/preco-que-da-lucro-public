DO $role$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    CREATE ROLE app_runtime LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  ELSE
    ALTER ROLE app_runtime NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT NOREPLICATION NOBYPASSRLS;
  END IF;
END
$role$;
--> statement-breakpoint
DO $grant_runtime$
BEGIN
  EXECUTE format('GRANT CONNECT ON DATABASE %I TO app_runtime', current_database());
END
$grant_runtime$;
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS app_private;
--> statement-breakpoint
REVOKE ALL ON SCHEMA app_private FROM PUBLIC;
--> statement-breakpoint
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
--> statement-breakpoint
GRANT USAGE ON SCHEMA public, app_private TO app_runtime;
--> statement-breakpoint
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM PUBLIC;
--> statement-breakpoint
-- Better Auth owns its own lifecycle, including session/account cleanup. The
-- database-backed rate limiter receives the same DML contract in 0002.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  users,
  sessions,
  accounts,
  verifications
TO app_runtime;
--> statement-breakpoint
-- Tenant bootstrap creates the tenant and profile; membership role changes are
-- the only tenant-scoped update outside the data tables below.
GRANT INSERT ON TABLE tenants, profiles TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE tenant_memberships TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE ON TABLE products, expenses, simulations, chat_conversations,
  idempotency_records, tool_executions, ai_daily_budgets
TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE
  product_ingredients,
  product_packaging,
  sales_fees
TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT ON TABLE market_prices TO app_runtime;
--> statement-breakpoint
GRANT SELECT, INSERT, DELETE ON TABLE chat_messages TO app_runtime;
--> statement-breakpoint
-- Audit events are append-only from the application role.
GRANT INSERT ON TABLE audit_events TO app_runtime;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_private.current_user_id()
RETURNS text
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT nullif(current_setting('app.current_user_id', true), '')
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_private.current_tenant_id()
RETURNS uuid
LANGUAGE sql
STABLE
PARALLEL SAFE
SET search_path = pg_catalog
AS $function$
  SELECT nullif(current_setting('app.current_tenant_id', true), '')::uuid
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_private.has_tenant_access(target_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.tenant_memberships membership
    WHERE membership.tenant_id = target_tenant_id
      AND membership.user_id = app_private.current_user_id()
  )
$function$;
--> statement-breakpoint
CREATE OR REPLACE FUNCTION app_private.has_tenant_owner_access(target_tenant_id uuid)
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
PARALLEL SAFE
SET search_path = pg_catalog, public
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.tenant_memberships membership
    WHERE membership.tenant_id = target_tenant_id
      AND membership.user_id = app_private.current_user_id()
      AND membership.role = 'owner'
  )
$function$;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_private.current_user_id() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_private.current_tenant_id() FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_private.has_tenant_access(uuid) FROM PUBLIC;
--> statement-breakpoint
REVOKE ALL ON FUNCTION app_private.has_tenant_owner_access(uuid) FROM PUBLIC;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_private.current_user_id() TO app_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_private.current_tenant_id() TO app_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_private.has_tenant_access(uuid) TO app_runtime;
--> statement-breakpoint
GRANT EXECUTE ON FUNCTION app_private.has_tenant_owner_access(uuid) TO app_runtime;
--> statement-breakpoint
ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenants_select ON tenants
  FOR SELECT TO app_runtime
  USING (
    id = app_private.current_tenant_id()
    AND app_private.has_tenant_access(id)
  );
--> statement-breakpoint
CREATE POLICY tenants_insert ON tenants
  FOR INSERT TO app_runtime
  WITH CHECK (
    id = app_private.current_tenant_id()
    AND app_private.current_user_id() IS NOT NULL
  );
--> statement-breakpoint
CREATE POLICY tenants_update ON tenants
  FOR UPDATE TO app_runtime
  USING (
    id = app_private.current_tenant_id()
    AND app_private.has_tenant_access(id)
  )
  WITH CHECK (
    id = app_private.current_tenant_id()
    AND app_private.has_tenant_access(id)
  );
--> statement-breakpoint
ALTER TABLE tenant_memberships ENABLE ROW LEVEL SECURITY;
--> statement-breakpoint
CREATE POLICY tenant_memberships_select ON tenant_memberships
  FOR SELECT TO app_runtime
  USING (user_id = app_private.current_user_id());
--> statement-breakpoint
CREATE POLICY tenant_memberships_insert_self ON tenant_memberships
  FOR INSERT TO app_runtime
  WITH CHECK (
    tenant_id = app_private.current_tenant_id()
    AND user_id = app_private.current_user_id()
  );
--> statement-breakpoint
CREATE POLICY tenant_memberships_update_owner ON tenant_memberships
  FOR UPDATE TO app_runtime
  USING (
    tenant_id = app_private.current_tenant_id()
    AND app_private.has_tenant_owner_access(tenant_id)
  )
  WITH CHECK (
    tenant_id = app_private.current_tenant_id()
    AND app_private.has_tenant_owner_access(tenant_id)
  );
--> statement-breakpoint
DO $tenant_rls$
DECLARE
  table_name text;
BEGIN
  FOREACH table_name IN ARRAY ARRAY[
    'profiles',
    'products',
    'product_ingredients',
    'product_packaging',
    'sales_fees',
    'market_prices',
    'expenses',
    'simulations',
    'chat_conversations',
    'chat_messages',
    'idempotency_records',
    'tool_executions',
    'ai_daily_budgets',
    'audit_events'
  ]
  LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I TO app_runtime USING (
        tenant_id = app_private.current_tenant_id()
        AND app_private.has_tenant_access(tenant_id)
      ) WITH CHECK (
        tenant_id = app_private.current_tenant_id()
        AND app_private.has_tenant_access(tenant_id)
      )',
      table_name
    );
  END LOOP;
END
$tenant_rls$;
