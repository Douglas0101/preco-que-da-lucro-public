-- better-auth 1.7.x matches credential accounts by issuer ('local:credential');
-- the column was added (0007) without backfill, so every account created under
-- 1.6.x or imported via raw SQL carries NULL and would fail sign-in with 401.
-- Idempotent data-only backfill (SAFE/DATA_MIGRATION per §27); never overwrites
-- a non-null issuer written by 1.7.x sign-up.
UPDATE "accounts" SET "issuer" = 'local:credential'
WHERE "provider_id" = 'credential' AND "issuer" IS NULL;
