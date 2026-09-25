CREATE TABLE "rate_limits" (
	"id" text DEFAULT gen_random_uuid()::text PRIMARY KEY NOT NULL,
	"key" text NOT NULL,
	"count" integer DEFAULT 0 NOT NULL,
	"last_request" bigint NOT NULL,
	CONSTRAINT "rate_limits_count_check" CHECK ("rate_limits"."count" >= 0)
);
--> statement-breakpoint
CREATE UNIQUE INDEX "rate_limits_key_uidx" ON "rate_limits" USING btree ("key");--> statement-breakpoint
CREATE INDEX "rate_limits_last_request_idx" ON "rate_limits" USING btree ("last_request");
--> statement-breakpoint
REVOKE ALL ON TABLE "rate_limits" FROM PUBLIC;
--> statement-breakpoint
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE "rate_limits" TO app_runtime;
