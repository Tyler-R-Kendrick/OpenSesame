ALTER TABLE "audit_events" ADD COLUMN "previous_digest" text;--> statement-breakpoint
ALTER TABLE "audit_events" ADD COLUMN "digest" text;