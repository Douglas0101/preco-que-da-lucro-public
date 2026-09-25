DROP SCHEMA IF EXISTS drizzle CASCADE;

-- ai_usage references tenants with ON DELETE CASCADE. Dropping a referenced
-- table removes that foreign key but leaves the dependent table in place, so
-- the global rollback must drop the ledger explicitly before replaying the
-- migration chain.
DROP TABLE IF EXISTS ai_usage CASCADE;

DROP TABLE IF EXISTS
  ai_memory_access_log,
  ai_memory_policies,
  ai_memory_conflicts,
  ai_memory_versions,
  ai_memory_sources,
  ai_memories,
  backfill_checkpoints,
  backfill_work_items,
  outbox_consumptions,
  outbox_events,
  audit_events,
  ai_daily_budgets,
  tool_executions,
  idempotency_records,
  calculation_snapshots,
  sales_items,
  sales,
  purchase_price_history,
  chat_messages,
  chat_conversations,
  simulations,
  expenses,
  market_prices,
  sales_fees,
  product_packaging,
  product_ingredients,
  profiles,
  products,
  rate_limits,
  rum_vitals,
  tenant_memberships,
  tenants,
  verifications,
  sessions,
  accounts,
  users
CASCADE;

DROP SCHEMA IF EXISTS app_private CASCADE;

DO $drop_runtime$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime') THEN
    DROP OWNED BY app_runtime;
    DROP ROLE app_runtime;
  END IF;
END
$drop_runtime$;
