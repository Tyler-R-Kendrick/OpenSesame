CREATE TABLE "interactions" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"status" text NOT NULL,
	"subject_kind" text NOT NULL,
	"subject_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"requester_ref" text,
	"approver_principal_id" text,
	"request_digest" text,
	"binding_message_digest" text,
	"binding_message" text,
	"authorization_details" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resource_ref" text,
	"assurance_required" jsonb,
	"approval_proof" jsonb,
	"presented_at" timestamp with time zone,
	"decided_at" timestamp with time zone,
	"consumed_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "interactions_kind_check" CHECK ("interactions"."kind" in ('device_authorization','pairing','claim','grant_claim','authorization_request','transaction_authorization')),
	CONSTRAINT "interactions_status_check" CHECK ("interactions"."status" in ('pending','presented','awaiting_approval','approved','denied','consumed','expired','revoked')),
	CONSTRAINT "interactions_subject_kind_check" CHECK ("interactions"."subject_kind" in ('device_authorization','pairing','claim','grant_claim','authorization_request','transaction_authorization')),
	CONSTRAINT "interactions_consumed_at_check" CHECK ("interactions"."consumed_at" is null or "interactions"."status" = 'consumed'),
	CONSTRAINT "interactions_decided_at_check" CHECK ("interactions"."status" not in ('denied','consumed') or "interactions"."decided_at" is not null)
);
--> statement-breakpoint
ALTER TABLE "interactions" ADD CONSTRAINT "interactions_approver_principal_id_principals_id_fk" FOREIGN KEY ("approver_principal_id") REFERENCES "public"."principals"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "interactions_live_subject_idx" ON "interactions" USING btree ("subject_kind","subject_id") WHERE "interactions"."status" in ('pending','presented','awaiting_approval','approved');--> statement-breakpoint
CREATE INDEX "interactions_expiry_idx" ON "interactions" USING btree ("expires_at") WHERE "interactions"."status" in ('pending','presented','awaiting_approval','approved');--> statement-breakpoint
CREATE INDEX "interactions_approver_idx" ON "interactions" USING btree ("approver_principal_id","status");