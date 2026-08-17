# ADR 0039: Event-driven GitHub backup actor

## Status

Accepted (supersedes the client-side-only backup posture of ADR 0038 §6 for
the hosted path; the CLI `pass backup` verb remains for local stores)

## Context

ADR 0038 made backup work, but only as a human CLI step: someone had to run
`opensesame pass backup`. The product goal is stronger — install the GitHub
App in the organization once, pick or create a repository, and from then on
*every* change to secrets, passwords, and vault items persists to GitHub
automatically. That requires the server to react to mutations, not a human to
remember them.

Three ingredients already existed but were unconnected: the `outbox_events`
table (migrated since 0001, used by nothing in Rust), the GitHub App Manifest
registration flow (which received the App's private key from the conversion
and threw it away), and a single transaction through which every broker
credential write passes.

## Decision

1. **Every secret mutation broadcasts a change event, transactionally.**
   Broker credential activation/clear/delete, E2EE sync-blob writes, and
   encrypted vault-item revisions insert an `outbox_events` row inside the
   same SQLite transaction as the mutation. The broadcast cannot be lost to a
   crash and cannot fire for a rolled-back write.
2. **An async actor owns delivery.** The gateway spawns one backup actor at
   startup. It drains the outbox on a short tick (and immediately on
   `backup_notify` after configuration changes), claims batches with a lease
   so a crashed pass expires instead of wedging the queue, and persists a
   snapshot to the configured repository.
3. **Events trigger; state is the source of truth.** Each delivery commits a
   *complete* ciphertext snapshot of current gateway state (sealed broker
   credentials, E2EE sync blobs, encrypted item revisions) via the Git Data
   API — one tree, one commit, one fast-forward ref update. Deletions in the
   source become deletions in the repo for free, retries are idempotent, and
   any successful pass reconciles everything earlier failures skipped.
4. **Compensating transactions, by failure class.**
   - *Transient* (network, 5xx, SQLite race): release the claim with
     exponential backoff; the only external residue is orphaned git objects,
     which are inert.
   - *Lost ref race* (409/422 on the ref update): discard the orphan commit
     and rebuild against the new head next pass.
   - *Installation revoked / repo gone / key rotated* (401/403/404): suspend
     the target (`status = suspended`, error recorded), park the events —
     a human reconfigures, then a resync replays everything.
   - *Poison batch* (8 failed attempts): dead-letter with the error recorded.
     Safe because of §3 — the next good snapshot carries the change anyway.
5. **The GitHub App is the only credential, minted server-side.** Manifest
   registration now seals the App's `app_id`, private key, and webhook secret
   into the org integration (declared optional configuration fields). The
   actor mints RS256 app JWTs → installation access tokens in-process, caches
   them until near expiry, and never persists or exposes them. ADR 0032 §6
   still holds: no route returns token material.
6. **Configuration is one PUT.** `PUT /api/v1/backup/target` names the
   integration, installation id (from the App setup redirect), owner, repo,
   and branch; it validates that the integration holds signing material and
   queues an immediate full resync. `GET` reports status + queue depth;
   `POST /api/v1/backup/resync` forces reconciliation; `DELETE` removes the
   target. Owner/admin role required, same as App registration.
7. **Only ciphertext travels.** Snapshot files are sealed broker credential
   rows (opened only by the deployment key, which never leaves the gateway)
   and E2EE blobs (opened only by user keys the server never held). The
   backup repository is private by default and worthless without keys that
   are not in it.

## Consequences

- Users configure once; persistence is continuous and unattended. The CLI is
  no longer in the backup loop for gateway-held secrets. Local sealed stores
  (`~/.password-store`) keep the ADR 0038 CLI path.
- The gateway gains its first background task. It is deliberately
  single-actor per process: SQLite's generation CAS and the outbox lease make
  a second process safe but redundant.
- GitHub webhooks stay a stub. Uninstallation is detected by the actor's own
  401/403/404 handling (suspend + park), which covers the same ground without
  trusting unauthenticated inbound calls.
- A deleted-then-recreated repository or force-pushed branch self-heals: the
  next snapshot is complete by construction.
