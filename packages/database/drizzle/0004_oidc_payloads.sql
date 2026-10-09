CREATE TABLE "oidc_payloads" (
	"model" text NOT NULL,
	"id" text NOT NULL,
	"payload" jsonb NOT NULL,
	"expires_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"uid" text,
	"user_code" text,
	"grant_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "oidc_payloads_model_id_pk" PRIMARY KEY("model","id")
);
--> statement-breakpoint
CREATE INDEX "oidc_payloads_uid_idx" ON "oidc_payloads" USING btree ("model","uid");--> statement-breakpoint
CREATE INDEX "oidc_payloads_user_code_idx" ON "oidc_payloads" USING btree ("model","user_code");--> statement-breakpoint
CREATE INDEX "oidc_payloads_grant_id_idx" ON "oidc_payloads" USING btree ("grant_id");--> statement-breakpoint
CREATE INDEX "oidc_payloads_expires_at_idx" ON "oidc_payloads" USING btree ("expires_at");