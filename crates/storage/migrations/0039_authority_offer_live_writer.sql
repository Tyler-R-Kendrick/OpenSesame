-- Live offers admit under a trusted writer's advancing envelope, not a frozen
-- roster digest. The writer is the only issuer that may attest membership at
-- activation; a permitted principal class is an optional extra bound. Snapshot
-- rows keep both columns NULL. Application code refuses a live create without
-- a writer, and refuses a live row that also carries a roster digest.

ALTER TABLE grant_offers ADD COLUMN trusted_writer TEXT;
ALTER TABLE grant_offers ADD COLUMN permitted_principal_class TEXT;
