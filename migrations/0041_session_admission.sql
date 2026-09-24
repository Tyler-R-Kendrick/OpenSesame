-- ADR 0137: a public session may admit whoever asks, as an observer holding
-- nothing. Every existing session keeps ADR 0079 §7's rule — the operator
-- decides — which is the column's default.
ALTER TABLE sessions ADD COLUMN admission TEXT NOT NULL DEFAULT 'operator'
    CHECK (admission IN ('operator', 'observer_on_ask'));
