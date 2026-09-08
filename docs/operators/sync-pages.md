# Encrypted sync pages and legacy ownership

The Host's `POST /api/v1/sync/pull-page` returns format
`opensesame-sync-page`, version 2. Requests contain `after: {epoch,id}`, an
optional device ID, and a limit (default 32, maximum 64). Responses are limited
to 8 MiB including JSON framing. Ciphertext is base64, never plaintext.

In version 2, `epoch` is the Host's durable ingestion sequence. It is allocated
transactionally for an accepted batch. `ciphertext_epoch` is the original
encrypted revision and must be preserved when decrypting, merging or restoring.
The Host never changes an authenticated encryption revision to fit pagination.
Independent vaults can upload revision 1 after another vault reaches revision
100 without disappearing behind a reader's cursor. Exact batch retries do not
allocate a new sequence or produce another mutation event.

Continue with the exact `next_after` until `has_more` is false. Equal ingestion
sequences are ordered by UTF-8 blob ID. Save a continuation only after processing
its page. A later accepted mutation appears after earlier ingestion cursors;
this is a current-state synchronization feed, not an immutable revision history.
Concurrent updates may repeat an ID at a newer ingestion sequence.

Legacy pull/snapshot routes are bounded compatibility surfaces. Nonzero old
`since_epoch` values are refused: reset once and use the explicit continuation.
Do not reuse a ciphertext revision as an ingestion cursor. The API client's
`syncPull` now returns one bounded page; streaming consumers use `syncPullPages`.
MCP tools likewise return one page and its explicit continuation.

## Existing ciphertext

Migration 0028 preserves old bytes and revisions under an empty, quarantined
organization. A newly authenticated caller cannot claim them by choosing an
organization. Scoped network reads, writes and organization backup exclude
quarantine. The offline operator rebind command requires a canonical principal,
an existing organization, explicit `blob-id=revision` entries, a SHA-256 digest
of reviewed ownership evidence, and confirmation. It updates the selected rows
atomically and records an audit/outbox event. The evidence digest is an audit
reference, not a replacement for the operator's ownership verification.

Back up the database before migration. To recover, restore that database while
services are stopped; do not apply an old binary to the migrated schema. No
automatic reverse migration collapses organization namespaces or deletes bytes.

## Export and backup

The CLI v2 export is JSON Lines: one format/version header, bounded page records,
then `{"complete":true}`. A missing completion marker means interruption, not a
complete backup. Files are created owner-only and never overwrite existing
paths. Restore reads bounded lines and preserves `ciphertext_epoch`; an
interrupted restore leaves already accepted ciphertext saved and can be retried.

Organization backup targets receive only that organization's connections,
vault revisions and scoped sync ciphertext. The actor independently routes and
settles each organization's events. Unbound historical events are recorded as
undeliverable and require explicit resync, never a Host-default organization.
Git delivery uploads one ciphertext blob at a time and retains only object
references in the tree request. Existing remote history is not deleted.
