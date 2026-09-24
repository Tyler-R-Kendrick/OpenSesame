-- Outbound delivery success and application of a human reply are different facts.
CREATE TABLE a2h_reply_claims (
  delivery_id TEXT PRIMARY KEY REFERENCES security_deliveries(id) ON DELETE CASCADE,
  organization_id TEXT NOT NULL,
  response_digest TEXT NOT NULL CHECK(length(response_digest) = 64),
  decision TEXT NOT NULL CHECK(decision IN ('acknowledge','cancel')),
  run_id TEXT,
  state TEXT NOT NULL CHECK(state IN ('applying','applied','dead_letter')),
  outcome TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX a2h_reply_claims_org ON a2h_reply_claims(organization_id, state);
