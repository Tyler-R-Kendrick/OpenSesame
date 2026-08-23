# ADR 0054: File attachment storage

## Status

Accepted (extends the sealed store of ADR 0037 and the backup posture of
ADR 0038 §2 to a second class of ciphertext)

## Context

People keep documents in a password manager, not just passwords: scans of tax
paperwork, passports, birth certificates, insurance policies. OpenSesame had
nowhere to put them. Nothing in the repository modelled a file — no attachment
type, no chunking, no streaming encryption — and the one place bytes could
plausibly have gone refuses the job on purpose: the Host sync plane caps a blob
at 2 MiB, with the comment "still bounded so sync is not a file dump"
(`apps/gateway/src/routes/sync.rs`). Raising that cap would turn an
authorization plane into a file server.

The 1Password importer already shows the cost of the gap. `.1pux` archives
carry attachments; `apps/pages/src/lib/vault/import/zip.ts` reads one text
entry and discards the rest, so a user migrating in silently loses their
documents.

Two requirements framed the design. The default tier has to be **free** — no
paid object store, no metered egress, nothing that turns a personal vault into
a subscription. And storing a government ID somewhere other than one's own
machine has to be **opt-in**, through the ordinary connector ceremony, with the
provider seeing ciphertext and nothing else.

## Options considered

| Option | Verdict | Why |
|---|---|---|
| **Chunked ciphertext in the git-native sealed store** | **Chosen** | Free private git remotes are ubiquitous; the store is already the backup fabric (ADR 0037/0038); works offline; E2EE is preserved end to end; no new service to run or trust. |
| Solid pods | Roadmap connector | The right ownership model, and ciphertext-only upload makes its access semantics tolerable. But there is no free durable hosting to point users at by default, and it would be the only tier depending on a server we do not control. |
| atproto PDS blobs | Roadmap connector | Reachable in principle, but this repository's atproto adapter is a deliberate fail-closed stub with no XRPC client, PDS blob quotas are small, and a referenced blob is effectively public — acceptable only because we would upload ciphertext, never as a default. |
| IPFS / pinning services | Rejected | Durability is the whole requirement, and unpinned content disappears. Pinning is paid, which breaks the free-tier constraint. |
| Gossip / peer replication | Rejected | Availability of someone's tax return must not depend on peer goodwill, and it would mean writing transport code, against ADR 0008's prefer-mature-libraries rule. |
| Tor or similar transports | Rejected | Solves reachability, not storage. Orthogonal to where the bytes live. |
| External storage only (Dropbox, Box, Drive) | Rejected as the default | Requires an account and a ceremony before a user can attach anything, and makes the baseline product depend on a third party. Correct as an opt-in tier, which is what it became. |
| Git LFS | Rejected | Not free at any meaningful volume, and it moves bytes out of the ciphertext-only path the rest of the store guarantees. |

## Decision

1. **Attachments are chunked, content-addressed ciphertext in the sealed
   store.** A file is split into 1 MiB plaintext chunks. Each chunk is sealed
   independently into a binary frame and stored at
   `.attachments/objects/<hex[0..2]>/<hex>.oschunk`, where `<hex>` is the
   BLAKE3 of the *ciphertext* frame. A sealed manifest at
   `<logical-path>.osattach` lists the chunk digests in order with the
   plaintext digest of the whole file. The manifest is the root of trust; a
   reader never touches a chunk the manifest did not vouch for.

2. **Chunks use a binary frame, manifests reuse the JSON envelope.** A frame is
   `OSCHNK1\n` + a 24-byte nonce + XChaCha20-Poly1305 ciphertext: 48 bytes of
   overhead. Routing chunks through the existing `.osseal` envelope would have
   cost roughly 37% in base64-in-JSON expansion and held the whole payload in
   memory. Manifests are small, so they keep the envelope and inherit its
   anti-rollback machinery unchanged.

3. **Every chunk binds its position.** The AEAD associated data is the digest
   of `{envelope_version, attachment_id, item_id, chunk_index, chunk_count}`.
   The attachment id blocks splicing a chunk in from another attachment, the
   index blocks reordering, and the count blocks truncation and extension.

   This is deliberately *not* the STREAM construction. STREAM chains nonces
   across a message, which would make chunks meaningful only in sequence — no
   random access, no per-chunk replication, no content addressing. Binding the
   position explicitly buys the same protections while keeping each chunk a
   standalone object, and adds no dependency.

4. **Keys are derived per attachment.**
   `AttachmentKey = HKDF-SHA256(ikm = ItemDataKey, salt = attachment_id,
   info = "opensesame/sealed-store/attachment/v1")`, with a fresh random
   16-byte attachment id per `attach add`. This is the first real derivation
   step toward the ladder in `docs/security/key-hierarchy.md`, which the
   shipped store currently collapses by setting the item key to the vault root
   key's bytes.

5. **No convergent encryption.** Because each attachment has its own key and
   random nonces, two attachments of the same document produce unrelated
   ciphertext and share no digests. Deduplication across attachments is given
   up on purpose: convergent encryption would let anyone holding the object
   pool learn that two users, or two entries, hold the identical file.

6. **Attachment ciphertext is committed and backed up like any other.**
   `auto_commit`'s allowlist gains `.osattach` and `.oschunk`, extending
   ADR 0038 §2's "only ciphertext travels" to the new file types. The local
   anti-rollback map `.opensesame-attachment-revisions.json` is deliberately
   excluded, exactly as the entry revision map is.

7. **Ordering is chunks first, manifest last.** A crash between the two leaves
   orphan objects, which are unreferenced ciphertext. `attach gc` reclaims
   them, but only after a one-hour grace window, so it cannot reap chunks from
   an `attach add` still in flight, and it removes nothing at all if any
   manifest fails to open — an unreadable manifest means we do not know what is
   still live.

8. **Reading is a human act.** `pass attach get` is gated by `require_reveal`
   on every path that emits plaintext, `--out` included, and the connector-host
   sealed-store provider refuses attachments outright. An agent holding a
   ConnectionRef can never read a document out of the store (ADR 0005/0037).

9. **The external tier is opt-in and client-driven.** A storage connection is
   established through the ordinary OAuth ceremony, then registered as an
   attachment target. Replication is driven by the client, which pushes sealed
   bytes; the gateway injects the provider credential and forwards them. There
   is deliberately no gateway-side replication actor in the ADR 0039 mould,
   because the gateway never possesses attachment chunks — such an actor would
   have nothing to replicate. `pass attach sync --to-dir` covers the
   encrypted-disk case with no gateway involvement at all, and needs no
   passphrase, since replication never opens what it moves.

## Consequences

- **Deletion is not erasure.** `attach rm` drops the manifest and reclaims
  unreferenced chunks, but git history retains the ciphertext and the store
  repository only grows. A user who must truly destroy a document has to
  rewrite history; tooling for that is future work, and the CLI says so rather
  than implying otherwise.
- **The free tier has a ceiling.** Attachments are capped at 1 GiB each, and
  hosted git remotes carry soft repository limits around 5 GB. The CLI warns
  above 50 MiB and points at external targets. Git LFS is not an answer here
  because it is not free.
- **Sizes leak even though content does not.** A remote holding the object pool
  learns how many chunks an attachment has and roughly how large it is.
  Padding chunks to a fixed size would close that and is left as future work.
- **No cross-attachment deduplication**, per decision 5. Storing the same file
  under two paths costs twice the space. This is the price of not leaking
  equality.
- **A second sealed collection now exists.** Entries bind `collection_id`
  `"entries"` and manifests bind `"attachments"`, so neither can be replayed as
  the other even at the same path and revision.

## Ceremony

Establishing an external target reuses the existing connector flow; only the
final registration is new:

```bash
# 1. Create and authorize a storage connection (existing ceremony).
curl -X POST "$HOST/api/v1/connections" \
  -d '{"provider_id":"dropbox","display_name":"Documents"}'
curl -X POST "$HOST/api/v1/connections/$ID/authorize"   # follow the returned URL

# 2. Register it as where attachment ciphertext should go.
curl -X PUT "$HOST/api/v1/attachments/target" \
  -d '{"connection_id":"'$ID'","folder_path":"/OpenSesame/attachments"}'
```

For an encrypted volume instead of a provider, no ceremony is involved:

```bash
opensesame pass attach sync --to-dir /Volumes/encrypted/opensesame
```
