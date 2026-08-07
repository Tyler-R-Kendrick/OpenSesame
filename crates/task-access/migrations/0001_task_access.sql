-- Task access distributed authority schema (ADR 0031)

CREATE TABLE IF NOT EXISTS task_runs (
    id TEXT PRIMARY KEY,
    template_id TEXT NOT NULL,
    organization_id TEXT NOT NULL,
    project_id TEXT,
    principal_id TEXT NOT NULL,
    authority_context_id TEXT NOT NULL,
    status TEXT NOT NULL,
    capability_ceiling JSONB NOT NULL,
    current_capabilities JSONB NOT NULL,
    state_version BIGINT NOT NULL,
    state_digest TEXT NOT NULL,
    ceiling_digest TEXT NOT NULL,
    maximum_expires_at TIMESTAMPTZ NOT NULL,
    pending_transition_id TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    updated_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_runs_org ON task_runs (organization_id);
CREATE INDEX IF NOT EXISTS idx_task_runs_pending ON task_runs (pending_transition_id)
    WHERE pending_transition_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS capability_transitions (
    id TEXT PRIMARY KEY,
    task_run_id TEXT NOT NULL REFERENCES task_runs (id) ON DELETE CASCADE,
    from_state_version BIGINT NOT NULL,
    to_state_version BIGINT NOT NULL,
    status TEXT NOT NULL,
    removed JSONB NOT NULL,
    resulting_capabilities JSONB NOT NULL,
    trigger_evidence_digest TEXT,
    created_at TIMESTAMPTZ NOT NULL,
    committed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_capability_transitions_run
    ON capability_transitions (task_run_id);

CREATE TABLE IF NOT EXISTS ack_sets (
    transition_id TEXT PRIMARY KEY REFERENCES capability_transitions (id) ON DELETE CASCADE,
    required JSONB NOT NULL,
    received JSONB NOT NULL DEFAULT '[]'::jsonb
);

CREATE TABLE IF NOT EXISTS result_buffers (
    task_run_id TEXT PRIMARY KEY REFERENCES task_runs (id) ON DELETE CASCADE,
    transition_id TEXT NOT NULL,
    state_version BIGINT NOT NULL,
    result_digest TEXT NOT NULL,
    payload JSONB NOT NULL,
    released BOOLEAN NOT NULL DEFAULT FALSE,
    created_at TIMESTAMPTZ NOT NULL
);

CREATE TABLE IF NOT EXISTS task_credentials (
    id TEXT PRIMARY KEY,
    task_run_id TEXT NOT NULL REFERENCES task_runs (id) ON DELETE CASCADE,
    credential_digest TEXT NOT NULL,
    state_version BIGINT NOT NULL,
    issued_at TIMESTAMPTZ NOT NULL,
    expires_at TIMESTAMPTZ NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_task_credentials_run ON task_credentials (task_run_id);
