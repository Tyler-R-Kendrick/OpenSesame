CREATE TABLE "authorization_requests" (
	"id" text PRIMARY KEY NOT NULL,
	"principal_id" text NOT NULL,
	"requester_ref" text NOT NULL,
	"authorization_details" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"request_digest" text NOT NULL,
	"binding_message" text NOT NULL,
	"status" text NOT NULL,
	"interval_seconds" integer DEFAULT 5 NOT NULL,
	"connection_id" text,
	"delegation_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"decided_at" timestamp with time zone,
	"decided_by_principal_id" text,
	"decided_by_kind" text,
	"version" integer DEFAULT 1 NOT NULL,
	CONSTRAINT "authorization_requests_status_check" CHECK ("authorization_requests"."status" in ('pending','approved','denied','expired','cancelled')),
	CONSTRAINT "authorization_requests_decided_by_kind_check" CHECK ("authorization_requests"."decided_by_kind" is null or "authorization_requests"."decided_by_kind" in ('human','agent'))
);
--> statement-breakpoint
ALTER TABLE "authorization_requests" ADD CONSTRAINT "authorization_requests_principal_id_principals_id_fk" FOREIGN KEY ("principal_id") REFERENCES "public"."principals"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "authorization_requests" ADD CONSTRAINT "authorization_requests_decided_by_principal_id_principals_id_fk" FOREIGN KEY ("decided_by_principal_id") REFERENCES "public"."principals"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "authorization_requests_principal_idx" ON "authorization_requests" USING btree ("principal_id","status");--> statement-breakpoint
CREATE INDEX "authorization_requests_pending_idx" ON "authorization_requests" USING btree ("expires_at") WHERE "authorization_requests"."status" = 'pending';
