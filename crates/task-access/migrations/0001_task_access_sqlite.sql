-- SQLite dialect of task access schema (local/dev, not distributed HA - ADR 0031)

CREATE TABLE IF NOT EXISTS task_runs (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    project_id TEXT,
    principal_id TEXT NOT NULL,
    authority_context_id TEXT NOT NULL,
    status TEXT NOT NULL,
    capability_ceiling TEXT NOT NULL,
    current_capabilities TEXT NOT NULL,
    state_version INTEGER NOT NULL,
    state_digest TEXT NOT NULL,
    ceiling_digest TEXT NOT NULL,
    maximum_expires_at TEXT NOT NULL,
    pending_transition_id TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_runs_org ON task_runs (organization_id);

CREATE TABLE IF NOT EXISTS capability_transitions (
    id TEXT PRIMARY KEY,
    task_run_id TEXT NOT NULL REFERENCES task_runs (id) ON DELETE CASCADE,
    from_state_version INTEGER NOT NULL,
    to_state_version INTEGER NOT NULL,
    status TEXT NOT NULL,
    removed TEXT NOT NULL,
    resulting_capabilities TEXT NOT NULL,
    trigger_evidence_digest TEXT,
    created_at TEXT NOT NULL,
    committed_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_capability_transitions_run
    ON capability_transitions (task_run_id);

CREATE TABLE IF NOT EXISTS ack_sets (
    transition_id TEXT PRIMARY KEY REFERENCES capability_transitions (id) ON DELETE CASCADE,
    required TEXT NOT NULL,
    received TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS result_buffers (
    task_run_id TEXT PRIMARY KEY REFERENCES task_runs (id) ON DELETE CASCADE,
    transition_id TEXT NOT NULL,
    state_version INTEGER NOT NULL,
    result_digest TEXT NOT NULL,
    payload TEXT NOT NULL,
    released INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS task_credentials (
    id TEXT PRIMARY KEY,
    task_run_id TEXT NOT NULL REFERENCES task_runs (id) ON DELETE CASCADE,
    credential_digest TEXT NOT NULL,
    state_version INTEGER NOT NULL,
    issued_at TEXT NOT NULL,
    expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_credentials_run ON task_credentials (task_run_id);
