ALTER TABLE "expenses" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "products" ADD COLUMN "version" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_version_check" CHECK ("expenses"."version" >= 0);--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_version_check" CHECK ("products"."version" >= 0);