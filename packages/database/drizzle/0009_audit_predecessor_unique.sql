CREATE UNIQUE INDEX IF NOT EXISTS "audit_events_previous_digest_uidx" ON "audit_events" USING btree ("previous_digest") WHERE "previous_digest" is not null and "digest" is not null;
