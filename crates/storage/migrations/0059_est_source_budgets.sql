-- Password-only EST enrollment cannot give one peer a profile-wide lockout.
-- Tags are host-keyed HMACs of authoritative transport sources, never guesses.
CREATE TABLE est_source_attempt_budgets (
    organization_id TEXT NOT NULL,
    config_id TEXT NOT NULL,
    source_tag TEXT NOT NULL CHECK (length(source_tag) = 64),
    expires_at INTEGER NOT NULL,
    attempts INTEGER NOT NULL CHECK (attempts BETWEEN 1 AND 5),
    PRIMARY KEY (organization_id, config_id, source_tag),
    FOREIGN KEY (organization_id, config_id)
        REFERENCES est_configs(organization_id, id) ON DELETE CASCADE
);
CREATE INDEX est_source_attempt_budgets_expiry
    ON est_source_attempt_budgets(organization_id, config_id, expires_at);
