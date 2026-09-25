CREATE TABLE "rum_vitals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"metric_id" text NOT NULL,
	"name" text NOT NULL,
	"value" double precision NOT NULL,
	"rating" text NOT NULL,
	"delta" double precision NOT NULL,
	"navigation_type" text,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX "rum_vitals_name_received_at_idx" ON "rum_vitals" USING btree ("name","received_at");--> statement-breakpoint
-- RUM é métrica de performance do browser, sem tenant_id e sem PII: não há RLS
-- (não existe escopo de tenant a isolar). A role de runtime é INSERT-only para
-- preservar a série append-only; a leitura fica com o operador via admin.
REVOKE ALL ON TABLE "rum_vitals" FROM PUBLIC;--> statement-breakpoint
GRANT INSERT ON TABLE "rum_vitals" TO app_runtime;