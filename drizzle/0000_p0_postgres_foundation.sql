CREATE TABLE "accounts" (
	"id" text PRIMARY KEY NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"user_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ai_daily_budgets" (
	"tenant_id" uuid NOT NULL,
	"usage_date" date NOT NULL,
	"chat_count" integer DEFAULT 0 NOT NULL,
	"model_call_count" integer DEFAULT 0 NOT NULL,
	"input_tokens" integer DEFAULT 0 NOT NULL,
	"output_tokens" integer DEFAULT 0 NOT NULL,
	"estimated_cost" numeric(19, 4) DEFAULT '0' NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "ai_daily_budgets_tenant_id_usage_date_pk" PRIMARY KEY("tenant_id","usage_date"),
	CONSTRAINT "ai_daily_budgets_nonnegative_check" CHECK ("ai_daily_budgets"."chat_count" >= 0 and "ai_daily_budgets"."model_call_count" >= 0 and "ai_daily_budgets"."input_tokens" >= 0 and "ai_daily_budgets"."output_tokens" >= 0 and "ai_daily_budgets"."estimated_cost" >= 0)
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"correlation_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"resource_type" text,
	"resource_id" text,
	"safe_metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "chat_conversations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"current_product_id" uuid,
	"confirmed_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reset_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_conversations_tenant_id_uidx" UNIQUE("tenant_id","id")
);
--> statement-breakpoint
CREATE TABLE "chat_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"conversation_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text NOT NULL,
	"content" text NOT NULL,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "chat_messages_role_check" CHECK ("chat_messages"."role" in ('user', 'assistant', 'system', 'tool'))
);
--> statement-breakpoint
CREATE TABLE "expenses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"category" text,
	"amount" numeric(19, 4) NOT NULL,
	"type" text DEFAULT 'fixa' NOT NULL,
	"periodicity" text DEFAULT 'mensal' NOT NULL,
	"is_demo" boolean DEFAULT false NOT NULL,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "expenses_amount_check" CHECK ("expenses"."amount" >= 0),
	CONSTRAINT "expenses_type_check" CHECK ("expenses"."type" in ('fixa', 'variavel'))
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"operation" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"response" jsonb,
	"error_code" text,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_records_status_check" CHECK ("idempotency_records"."status" in ('pending', 'succeeded', 'failed'))
);
--> statement-breakpoint
CREATE TABLE "market_prices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"min_price" numeric(19, 4),
	"avg_price" numeric(19, 4),
	"max_price" numeric(19, 4),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "market_prices_min_check" CHECK ("market_prices"."min_price" is null or "market_prices"."min_price" >= 0),
	CONSTRAINT "market_prices_avg_check" CHECK ("market_prices"."avg_price" is null or "market_prices"."avg_price" >= 0),
	CONSTRAINT "market_prices_max_check" CHECK ("market_prices"."max_price" is null or "market_prices"."max_price" >= 0)
);
--> statement-breakpoint
CREATE TABLE "product_ingredients" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"used_qty" numeric(24, 6) NOT NULL,
	"used_unit" text NOT NULL,
	"package_price" numeric(19, 4),
	"package_qty" numeric(24, 6),
	"package_unit" text,
	"conversion_factor" numeric(24, 8),
	"price_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_ingredients_used_qty_check" CHECK ("product_ingredients"."used_qty" > 0),
	CONSTRAINT "product_ingredients_package_price_check" CHECK ("product_ingredients"."package_price" is null or "product_ingredients"."package_price" >= 0),
	CONSTRAINT "product_ingredients_package_qty_check" CHECK ("product_ingredients"."package_qty" is null or "product_ingredients"."package_qty" > 0),
	CONSTRAINT "product_ingredients_conversion_factor_check" CHECK ("product_ingredients"."conversion_factor" is null or "product_ingredients"."conversion_factor" > 0)
);
--> statement-breakpoint
CREATE TABLE "product_packaging" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"package_price" numeric(19, 4) NOT NULL,
	"units_per_package" numeric(24, 6) NOT NULL,
	"price_updated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_packaging_price_check" CHECK ("product_packaging"."package_price" >= 0),
	CONSTRAINT "product_packaging_units_check" CHECK ("product_packaging"."units_per_package" > 0)
);
--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"current_price" numeric(19, 4),
	"yield_qty" numeric(24, 6),
	"yield_unit" text,
	"tax_regime" text,
	"tax_rate" numeric(9, 6),
	"is_demo" boolean DEFAULT false NOT NULL,
	"notes" text,
	"archived_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_tenant_id_id_uidx" UNIQUE("tenant_id","id"),
	CONSTRAINT "products_current_price_check" CHECK ("products"."current_price" is null or "products"."current_price" >= 0),
	CONSTRAINT "products_yield_qty_check" CHECK ("products"."yield_qty" is null or "products"."yield_qty" > 0),
	CONSTRAINT "products_tax_rate_check" CHECK ("products"."tax_rate" is null or ("products"."tax_rate" >= 0 and "products"."tax_rate" <= 1))
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" text PRIMARY KEY NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"email" text,
	"display_name" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "profiles_identity_check" CHECK ("profiles"."id" = "profiles"."user_id")
);
--> statement-breakpoint
CREATE TABLE "sales_fees" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"product_id" uuid NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"percentage" numeric(9, 6) NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sales_fees_percentage_check" CHECK ("sales_fees"."percentage" >= 0 and "sales_fees"."percentage" <= 1)
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"token" text NOT NULL,
	"user_id" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "simulations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"product_id" uuid,
	"name" text NOT NULL,
	"params" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_memberships" (
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"role" text DEFAULT 'owner' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_memberships_tenant_id_user_id_pk" PRIMARY KEY("tenant_id","user_id"),
	CONSTRAINT "tenant_memberships_role_check" CHECK ("tenant_memberships"."role" in ('owner', 'admin', 'member'))
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"kind" text DEFAULT 'personal' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_kind_check" CHECK ("tenants"."kind" in ('personal', 'organization'))
);
--> statement-breakpoint
CREATE TABLE "tool_executions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"correlation_id" uuid NOT NULL,
	"tool_name" text NOT NULL,
	"input_hash" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"duration_ms" integer,
	"safe_result" jsonb,
	"error_code" text,
	"idempotency_key" text,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "tool_executions_status_check" CHECK ("tool_executions"."status" in ('pending', 'succeeded', 'failed', 'cancelled')),
	CONSTRAINT "tool_executions_duration_check" CHECK ("tool_executions"."duration_ms" is null or "tool_executions"."duration_ms" >= 0)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "accounts" ADD CONSTRAINT "accounts_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ai_daily_budgets" ADD CONSTRAINT "ai_daily_budgets_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_tenant_id_user_id_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_tenant_id_current_product_id_products_tenant_id_id_fk" FOREIGN KEY ("tenant_id","current_product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_conversations" ADD CONSTRAINT "chat_conversations_tenant_id_user_id_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_tenant_id_conversation_id_chat_conversations_tenant_id_id_fk" FOREIGN KEY ("tenant_id","conversation_id") REFERENCES "public"."chat_conversations"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "chat_messages" ADD CONSTRAINT "chat_messages_tenant_id_user_id_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "expenses" ADD CONSTRAINT "expenses_tenant_id_user_id_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_tenant_id_user_id_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_prices" ADD CONSTRAINT "market_prices_tenant_id_product_id_products_tenant_id_id_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "market_prices" ADD CONSTRAINT "market_prices_tenant_id_user_id_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_ingredients" ADD CONSTRAINT "product_ingredients_tenant_id_product_id_products_tenant_id_id_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_ingredients" ADD CONSTRAINT "product_ingredients_tenant_id_user_id_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_packaging" ADD CONSTRAINT "product_packaging_tenant_id_product_id_products_tenant_id_id_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_packaging" ADD CONSTRAINT "product_packaging_tenant_id_user_id_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_user_id_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_id_users_id_fk" FOREIGN KEY ("id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_tenant_id_user_id_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fees" ADD CONSTRAINT "sales_fees_tenant_id_product_id_products_tenant_id_id_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sales_fees" ADD CONSTRAINT "sales_fees_tenant_id_user_id_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulations" ADD CONSTRAINT "simulations_tenant_id_product_id_products_tenant_id_id_fk" FOREIGN KEY ("tenant_id","product_id") REFERENCES "public"."products"("tenant_id","id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "simulations" ADD CONSTRAINT "simulations_tenant_id_user_id_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tool_executions" ADD CONSTRAINT "tool_executions_tenant_id_user_id_tenant_memberships_tenant_id_user_id_fk" FOREIGN KEY ("tenant_id","user_id") REFERENCES "public"."tenant_memberships"("tenant_id","user_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "accounts_provider_account_uidx" ON "accounts" USING btree ("provider_id","account_id");--> statement-breakpoint
CREATE INDEX "accounts_user_id_idx" ON "accounts" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "audit_events_tenant_created_idx" ON "audit_events" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_events_correlation_idx" ON "audit_events" USING btree ("correlation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_conversations_tenant_user_uidx" ON "chat_conversations" USING btree ("tenant_id","user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "chat_messages_tenant_id_id_uidx" ON "chat_messages" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "chat_messages_tenant_conversation_created_idx" ON "chat_messages" USING btree ("tenant_id","conversation_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "expenses_tenant_id_id_uidx" ON "expenses" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "expenses_tenant_created_idx" ON "expenses" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "idempotency_records_scope_uidx" ON "idempotency_records" USING btree ("tenant_id","user_id","operation","key");--> statement-breakpoint
CREATE INDEX "idempotency_records_expires_idx" ON "idempotency_records" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "market_prices_tenant_id_id_uidx" ON "market_prices" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "market_prices_tenant_product_created_idx" ON "market_prices" USING btree ("tenant_id","product_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "product_ingredients_tenant_id_id_uidx" ON "product_ingredients" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "product_ingredients_tenant_product_idx" ON "product_ingredients" USING btree ("tenant_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "product_packaging_tenant_id_id_uidx" ON "product_packaging" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "product_packaging_tenant_product_idx" ON "product_packaging" USING btree ("tenant_id","product_id");--> statement-breakpoint
CREATE INDEX "products_tenant_created_idx" ON "products" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "products_tenant_active_idx" ON "products" USING btree ("tenant_id","archived_at");--> statement-breakpoint
CREATE UNIQUE INDEX "profiles_tenant_id_id_uidx" ON "profiles" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE UNIQUE INDEX "sales_fees_tenant_id_id_uidx" ON "sales_fees" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "sales_fees_tenant_product_idx" ON "sales_fees" USING btree ("tenant_id","product_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sessions_token_uidx" ON "sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "sessions_user_id_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_at_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE UNIQUE INDEX "simulations_tenant_id_id_uidx" ON "simulations" USING btree ("tenant_id","id");--> statement-breakpoint
CREATE INDEX "simulations_tenant_created_idx" ON "simulations" USING btree ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "tenant_memberships_user_id_idx" ON "tenant_memberships" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_slug_uidx" ON "tenants" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "tool_executions_idempotency_uidx" ON "tool_executions" USING btree ("tenant_id","user_id","tool_name","idempotency_key");--> statement-breakpoint
CREATE INDEX "tool_executions_tenant_started_idx" ON "tool_executions" USING btree ("tenant_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uidx" ON "users" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX "verifications_identifier_idx" ON "verifications" USING btree ("identifier");--> statement-breakpoint
CREATE INDEX "verifications_expires_at_idx" ON "verifications" USING btree ("expires_at");