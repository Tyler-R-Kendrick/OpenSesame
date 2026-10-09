CREATE TABLE "agent_registrations" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"principal_id" text NOT NULL,
	"claimed_by_principal_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"claimed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"pre_claim_scopes" jsonb NOT NULL,
	"post_claim_scopes" jsonb NOT NULL,
	"resource" text,
	"audience" text,
	"claim_email_normalized" text,
	"claim_token_digest" bytea,
	"assertion_version" integer DEFAULT 1 NOT NULL,
	"provider_issuer" text,
	"provider_subject" text,
	"provider_client_id" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "agent_registrations_kind_check" CHECK ("agent_registrations"."kind" in ('anonymous','service_auth','provider_assertion')),
	CONSTRAINT "agent_registrations_status_check" CHECK ("agent_registrations"."status" in ('unclaimed','claim_pending','claimed','expired','revoked'))
);
--> statement-breakpoint
CREATE TABLE "agent_claim_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"registration_id" text NOT NULL,
	"attempt_token_digest" bytea NOT NULL,
	"user_code_digest" bytea NOT NULL,
	"email_normalized" text,
	"expires_at" timestamp with time zone NOT NULL,
	"interval_seconds" integer NOT NULL,
	"slowdown_until" timestamp with time zone,
	"poll_count" integer DEFAULT 0 NOT NULL,
	"failed_attempts" integer DEFAULT 0 NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_access_tokens" (
	"id" text PRIMARY KEY NOT NULL,
	"registration_id" text NOT NULL,
	"token_digest" bytea NOT NULL,
	"scopes" jsonb NOT NULL,
	"claimed" boolean NOT NULL,
	"assertion_version" integer NOT NULL,
	"resource" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_service_assertions" (
	"jti" text PRIMARY KEY NOT NULL,
	"registration_id" text NOT NULL,
	"assertion_version" integer NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_registrations" ADD CONSTRAINT "agent_registrations_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_registrations" ADD CONSTRAINT "agent_registrations_claimed_by_principal_id_principals_id_fk" FOREIGN KEY ("claimed_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_claim_attempts" ADD CONSTRAINT "agent_claim_attempts_registration_id_agent_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."agent_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_access_tokens" ADD CONSTRAINT "agent_access_tokens_registration_id_agent_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."agent_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_service_assertions" ADD CONSTRAINT "agent_service_assertions_registration_id_agent_registrations_id_fk" FOREIGN KEY ("registration_id") REFERENCES "public"."agent_registrations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "agent_registrations_claim_token_digest_uidx" ON "agent_registrations" USING btree ("claim_token_digest");--> statement-breakpoint
CREATE INDEX "agent_registrations_status_expires_idx" ON "agent_registrations" USING btree ("status","expires_at");--> statement-breakpoint
CREATE INDEX "agent_registrations_principal_id_idx" ON "agent_registrations" USING btree ("principal_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_claim_attempts_token_digest_uidx" ON "agent_claim_attempts" USING btree ("attempt_token_digest");--> statement-breakpoint
CREATE INDEX "agent_claim_attempts_registration_id_idx" ON "agent_claim_attempts" USING btree ("registration_id");--> statement-breakpoint
CREATE UNIQUE INDEX "agent_access_tokens_token_digest_uidx" ON "agent_access_tokens" USING btree ("token_digest");--> statement-breakpoint
CREATE INDEX "agent_access_tokens_registration_id_idx" ON "agent_access_tokens" USING btree ("registration_id");--> statement-breakpoint
CREATE INDEX "agent_service_assertions_registration_idx" ON "agent_service_assertions" USING btree ("registration_id","assertion_version");
