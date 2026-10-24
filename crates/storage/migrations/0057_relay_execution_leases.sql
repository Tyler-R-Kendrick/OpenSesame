-- Approval is the atomic, single-use execution handoff. Legacy approvals
-- have no lease and cannot execute or be redelivered.
ALTER TABLE relay_requests ADD COLUMN execution_lease TEXT;
ALTER TABLE relay_requests ADD COLUMN execution_expires_at TEXT;
ALTER TABLE relay_requests ADD COLUMN execution_authority_digest TEXT;
UPDATE relay_requests SET state = 'failed' WHERE state = 'approved';
