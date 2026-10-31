-- Credential guesses and sign-in requests survive Host restarts/replicas.
-- Buckets contain digests, never account identifiers or presented secrets.
CREATE TABLE bitwarden_attempt_budgets (
    namespace TEXT NOT NULL,
    bucket TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL CHECK (attempts > 0),
    PRIMARY KEY (namespace, bucket)
);
CREATE INDEX bitwarden_attempt_budgets_expiry
    ON bitwarden_attempt_budgets(namespace, expires_at);
