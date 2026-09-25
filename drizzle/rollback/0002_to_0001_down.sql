-- REVOKE does not support IF EXISTS for a specific relation in PostgreSQL;
-- the guard follows the DO pattern of 0001_to_0000_down.sql. The indexes
-- rate_limits_key_uidx and rate_limits_last_request_idx go away with the table.
DO $revoke_runtime$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_runtime')
     AND to_regclass('public.rate_limits') IS NOT NULL THEN
    EXECUTE 'REVOKE ALL ON TABLE public.rate_limits FROM app_runtime';
  END IF;
END
$revoke_runtime$;
DROP TABLE IF EXISTS public.rate_limits CASCADE;
