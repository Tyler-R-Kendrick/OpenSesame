# Bounded encrypted sync and tenant-scoped backup

Source review traced unbounded ciphertext reads through Host pull/snapshot,
backup collection and inline Git tree construction. Backup also selected the
Host's default organization after claiming events across all organizations.

The implementation introduces SQL keyset limits and pre-body byte accounting,
versioned base64 pages, durable ingestion sequences independent of encryption
revisions, organization-scoped keys, and explicit quarantine/rebind for legacy
rows. First-party Pages and API consumers process continuations; MCP exposes
one bounded page per tool call. CLI exports use bounded JSON Lines records.

Backup event routing resolves canonical organization ownership and maintains
independent delivery outcomes. Scoped queries exclude foreign tenant and
quarantined ciphertext. Git uploads stream individual ciphertext blobs and
retain object references, not all ciphertext bodies, for the tree request.
Existing historical remote objects remain intact.

Focused evidence on the implementation worktree:

- `cargo +1.88.0 test -p opensesame-storage --test sync_pages`: 8 passed,
  including restart persistence, exact retry, backdated ciphertext revisions,
  equal-sequence ordering, organization isolation, byte accounting and atomic
  legacy rebind.
- `cargo +1.88.0 clippy -p opensesame-storage --lib -- -D warnings`: passed.
- API pagination and MCP consumer suites: 74 tests passed.

These are focused results, not a claim that the complete integrated Gateway,
CLI, browser journey, scanner or repository verification gates ran. Final
integration must verify route registration, migration registry, CLI dispatch,
real serialization limits and per-organization backup delivery.

Residual properties: sync is a current-state feed, not a revision-history log;
concurrent updates can repeat an ID at a newer ingestion sequence. The server
remains unable to decrypt ciphertext. Legacy ownership cannot be inferred from
a new caller; an operator must review evidence before explicitly rebinding it.
Previously published cross-tenant backup material is not automatically erased;
operators must review destination access and retention separately.
