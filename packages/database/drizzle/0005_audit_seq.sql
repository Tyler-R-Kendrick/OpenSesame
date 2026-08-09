ALTER TABLE "audit_events" ADD COLUMN "seq" bigserial NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "audit_events_seq_idx" ON "audit_events" USING btree ("seq");
