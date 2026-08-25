-- Claimable connection delegation (ADR 0044) and relayed execution (ADR 0046).
--
-- Delegation is authority-plane state, beside the connections it narrows.
-- Offers always carry items: a single-connection share is a one-item offer, so
-- group delegation is schema-native rather than a retrofit. No table here ever
-- holds credential material or a claim token — only their hashes.

CREATE TABLE IF NOT EXISTS connection_delegation_offers (
  id                TEXT PRIMARY KEY,            -- dlgo_…; doubles as the delegation-set id
  organization_id   TEXT NOT NULL,
  owner_subject     TEXT NOT NULL,               -- who minted; must own every item's connection
  claim_token_hash  TEXT NOT NULL UNIQUE,        -- purpose-separated hash; never the token
  user_code_hash    TEXT NOT NULL,               -- hash_low_entropy(pepper, offer_id, code)
  manifest_digest   TEXT NOT NULL,               -- canonical item-set digest, immutable
  code_attempts     INTEGER NOT NULL DEFAULT 0,  -- wrong user codes seen; offer burns at the cap
  state             TEXT NOT NULL,               -- pending|presented|claimed|revoked|expired|burned
  presented_at      TEXT,
  claimed_at        TEXT,
  revoked_at        TEXT,
  expires_at        TEXT NOT NULL,               -- default 600 s, ceiling 86 400 s
  created_at        TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_delegation_offers_owner
  ON connection_delegation_offers(organization_id, owner_subject);

CREATE TABLE IF NOT EXISTS connection_delegation_offer_items (
  id             TEXT PRIMARY KEY,               -- dlgi_…
  offer_id       TEXT NOT NULL REFERENCES connection_delegation_offers(id) ON DELETE CASCADE,
  connection_id  TEXT NOT NULL,                  -- broker connections row; soft ref like grants
  proposed_grant TEXT NOT NULL,                  -- JSON child-grant proposal, validated at mint
  execution_mode TEXT NOT NULL DEFAULT 'broker', -- broker | relay (ADR 0046 decision 1)
  required       INTEGER NOT NULL DEFAULT 1,
  dependencies   TEXT NOT NULL DEFAULT '[]',     -- JSON string[] of sibling item ids
  state          TEXT NOT NULL,                  -- pending|accepted|rejected
  UNIQUE(offer_id, connection_id)
);

CREATE TABLE IF NOT EXISTS connection_delegations (
  id                    TEXT PRIMARY KEY,        -- dlg_…
  offer_id              TEXT NOT NULL REFERENCES connection_delegation_offers(id),
  offer_item_id         TEXT NOT NULL REFERENCES connection_delegation_offer_items(id),
  connection_id         TEXT NOT NULL,
  organization_id       TEXT NOT NULL,
  owner_subject         TEXT NOT NULL,
  claimant_subject      TEXT NOT NULL,
  claimant_instance_jkt TEXT,
  grant_id              TEXT NOT NULL,           -- child grant (grants table)
  parent_grant_id       TEXT NOT NULL,
  delegation_depth      INTEGER NOT NULL,
  execution_mode        TEXT NOT NULL DEFAULT 'broker',
  budget_remaining      TEXT,                    -- JSON mirror of GrantConstraints.budgets
  expires_at            TEXT NOT NULL,
  revoked_at            TEXT,
  created_at            TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_delegations_claimant
  ON connection_delegations(claimant_subject, connection_id);
CREATE INDEX IF NOT EXISTS idx_delegations_set
  ON connection_delegations(offer_id);

-- Relayed execution requests (ADR 0046): the credential stays with its holder;
-- the delegate's frozen request travels. Rows exist only while a live holder
-- is expected to pick them up — an offline holder refuses at submit, it never
-- queues (crates/relay admission).
CREATE TABLE IF NOT EXISTS relay_requests (
  id               TEXT PRIMARY KEY,             -- rreq_…
  delegation_id    TEXT NOT NULL REFERENCES connection_delegations(id),
  connection_id    TEXT NOT NULL,
  organization_id  TEXT NOT NULL,
  holder_subject   TEXT NOT NULL,                -- the credential holder who executes
  delegate_subject TEXT NOT NULL,                -- who asked
  operation        TEXT NOT NULL,
  resource         TEXT NOT NULL,
  parameters_json  TEXT NOT NULL,
  request_digest   TEXT NOT NULL,                -- canonical digest; approval + result bind to it
  state            TEXT NOT NULL,                -- pending_approval|approved|denied|completed|failed|expired
  approved_at      TEXT,
  decided_by       TEXT,
  result_json      TEXT,                         -- holder-reported safe summary; leak-checked
  result_outcome   TEXT,                         -- succeeded | failed
  expires_at       TEXT NOT NULL,
  created_at       TEXT NOT NULL,
  completed_at     TEXT
);

CREATE INDEX IF NOT EXISTS idx_relay_requests_holder
  ON relay_requests(holder_subject, state);
