CREATE TABLE "execution_reservations" (
	"id" text PRIMARY KEY NOT NULL,
	"interaction_id" text NOT NULL,
	"request_digest" text NOT NULL,
	"fencing_token" integer NOT NULL,
	"holder_ref" text NOT NULL,
	"status" text NOT NULL,
	"lease_expires_at" timestamp with time zone NOT NULL,
	"committed_at" timestamp with time zone,
	"released_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "execution_reservations_status_check" CHECK ("execution_reservations"."status" in ('held','committed','released','expired'))
);
--> statement-breakpoint
CREATE TABLE "interaction_approval_quarantine" (
	"interaction_id" text PRIMARY KEY NOT NULL,
	"prior_status" text NOT NULL,
	"reason" text NOT NULL,
	"quarantined_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "interaction_proof_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"interaction_id" text NOT NULL,
	"mechanism" text NOT NULL,
	"outcome" text NOT NULL,
	"proof_input_digest" "bytea" NOT NULL,
	"bound_digest" text,
	"expected_digest" text,
	"credential_ref" text,
	"assurance" text,
	"approver_principal_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "interaction_proof_attempts_mechanism_check" CHECK ("interaction_proof_attempts"."mechanism" in ('webauthn','openid4vp')),
	CONSTRAINT "interaction_proof_attempts_outcome_check" CHECK ("interaction_proof_attempts"."outcome" in ('accepted','rejected_digest_mismatch','rejected_verification','rejected_assurance','rejected_expired','rejected_replayed'))
);
--> statement-breakpoint
CREATE TABLE "wallet_registrations" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"status" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"provider_object_ref" text NOT NULL,
	"provider_subject" text,
	"interaction_id" text,
	"approver_principal_id" text,
	"pass_reference_digest" "bytea",
	"expires_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_registrations_status_check" CHECK ("wallet_registrations"."status" in ('active','revoked','expired','superseded'))
);
--> statement-breakpoint
ALTER TABLE "execution_reservations" ADD CONSTRAINT "execution_reservations_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_proof_attempts" ADD CONSTRAINT "interaction_proof_attempts_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "interaction_proof_attempts" ADD CONSTRAINT "interaction_proof_attempts_approver_principal_id_principals_id_fk" FOREIGN KEY ("approver_principal_id") REFERENCES "public"."principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_registrations" ADD CONSTRAINT "wallet_registrations_interaction_id_interactions_id_fk" FOREIGN KEY ("interaction_id") REFERENCES "public"."interactions"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "wallet_registrations" ADD CONSTRAINT "wallet_registrations_approver_principal_id_principals_id_fk" FOREIGN KEY ("approver_principal_id") REFERENCES "public"."principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "execution_reservations_token_uidx" ON "execution_reservations" USING btree ("interaction_id","fencing_token");--> statement-breakpoint
CREATE UNIQUE INDEX "execution_reservations_committed_uidx" ON "execution_reservations" USING btree ("interaction_id") WHERE status = 'committed';--> statement-breakpoint
CREATE INDEX "execution_reservations_lease_idx" ON "execution_reservations" USING btree ("lease_expires_at") WHERE status = 'held';--> statement-breakpoint
CREATE UNIQUE INDEX "interaction_proof_attempts_input_digest_uidx" ON "interaction_proof_attempts" USING btree ("proof_input_digest");--> statement-breakpoint
CREATE UNIQUE INDEX "interaction_proof_attempts_accepted_uidx" ON "interaction_proof_attempts" USING btree ("interaction_id") WHERE outcome = 'accepted';--> statement-breakpoint
CREATE INDEX "interaction_proof_attempts_interaction_created_idx" ON "interaction_proof_attempts" USING btree ("interaction_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_registrations_active_subject_uidx" ON "wallet_registrations" USING btree ("provider","subject_kind","subject_id") WHERE status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "wallet_registrations_active_object_uidx" ON "wallet_registrations" USING btree ("provider","provider_object_ref") WHERE status = 'active';--> statement-breakpoint
CREATE INDEX "wallet_registrations_approver_idx" ON "wallet_registrations" USING btree ("approver_principal_id","status");--> statement-breakpoint
CREATE INDEX "wallet_registrations_expiry_idx" ON "wallet_registrations" USING btree ("expires_at") WHERE status = 'active';--> statement-breakpoint
-- Finding F12: quarantine legacy session-only approvals BEFORE the guard below
-- is added. An `approved` interaction with no durable `approval_proof` was
-- approved in a process whose memory is gone; it must not remain spendable.
-- Record why first, then revoke it so it cannot be consumed. Revoking (not
-- deleting) keeps the audit trail; re-approval must go through the durable path.
INSERT INTO "interaction_approval_quarantine" ("interaction_id", "prior_status", "reason")
SELECT "id", "status", 'legacy_session_only_approval'
FROM "interactions"
WHERE "status" = 'approved' AND "approval_proof" IS NULL
ON CONFLICT ("interaction_id") DO NOTHING;--> statement-breakpoint
UPDATE "interactions"
SET "status" = 'revoked', "revoked_at" = now(), "version" = "version" + 1
WHERE "status" = 'approved' AND "approval_proof" IS NULL;--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_approved_proof_check" CHECK ("interactions"."status" <> 'approved' or "interactions"."approval_proof" is not null);