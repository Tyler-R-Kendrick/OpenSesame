# Security review — browser-local SOPS

A record of what was examined, what holds, and what was **not** examined.
This is a self-review by the author of the change. It is not an audit, and
nothing here should be read as one.

## Threat model in one paragraph

The document is untrusted input: it arrives from a file the person chose,
and an attacker may have written every byte of it, including its `sops:`
metadata block and any `.sops.yaml` beside it. The identity is the most
sensitive thing in the session. The page is shared with the rest of the
Pages app, which includes an in-product support model and WebMCP tools —
neither of which may reach plaintext, an identity, or a data key.

## What holds, and why

### The document cannot make the app do anything

- **No endpoint from metadata.** A document's `sops:` block names *which*
  key was used; a provider URL is derived from configuration the person
  approved (`assertSopsHttpsEndpoint`, which refuses non-HTTPS, private,
  loopback, metadata-service and userinfo URLs). `metadata.ts` contains no
  URL at all, and a test asserts it.
- **No command, ever.** Nothing in the engine spawns, evaluates, or
  interprets a value from a document or a `.sops.yaml`. `config.ts` refuses
  the `exec-env`, `exec-file`, `publish`, plugin and key-service keys
  outright rather than ignoring them.
- **No regex denial of service.** Selector regexes run on a Thompson NFA
  simulation with no backtracking, a 4,000-instruction program cap and a
  2,000,000-step execution cap. A pattern that would make a backtracking
  engine hang is linear here, and one that exceeds a cap is refused.
- **Bounded everything else.** 8 MiB input, 64 levels of nesting, 100,000
  nodes, 32 documents, 32 key groups, 128 recipient entries. Past a bound
  the engine names the limit rather than degrading.

### Authentication is not optional

A document whose MAC does not verify does not open — there is no "open
anyway". Record additional data is the `:`-terminated key path, so a record
moved within a document fails to authenticate. The MAC itself is sealed
under `lastmodified`, so the timestamp cannot be edited in isolation. The
conformance gate checks the converse too: upstream rejects a browser-written
file whose MAC was deliberately broken.

A threshold document that cannot reach its threshold does not open. It is
never partially opened and never rewritten under a weaker policy.

### Nothing secret leaves the browser, and the local path leaves the origin not at all

- The whole local-age path is offline-verified: service worker installed,
  context set offline, full workflow re-run.
- The request watch recorded **0** requests to any other origin across the
  entire workflow.
- No engine module calls `console.*`, `sendBeacon`, the clipboard, or
  constructs a `URLSearchParams`. Asserted by test over the shipped sources.
- Errors are a closed set of codes with fixed messages. `redactError` never
  copies a caught exception's text, because a parser or library exception
  can quote source bytes.

### Agents and the support model have no path in

- No WebMCP tool names a SOPS, decrypt, identity or data-key operation, and
  none accepts one in its schema.
- No WebMCP, support-agent, tutorial or analytics module imports the
  engine, the worker, the session, or the age key module.
- The engine exposes no `getSecret`, no raw key accessor and no root
  unwrap. Plaintext is reached only through a handle bound to an execution
  permit and the current session generation.
- The worker answers a fixed set of operations. There is no generic verb.

### Identity and session handling

- A sealed identity is readable only from a fully unlocked, non-guest
  session with no pending second step, and only from the addressed tomb.
  A guest is isolated; a locked or awaiting-second-step session gets
  nothing.
- A lock, logout, or vault switch during a pending operation discards the
  result and the handle. Work opened in one vault cannot be saved into
  another.
- Ephemeral identities are held in memory for the operation and are not
  persisted.
- An import is decrypted whole, then written as **one** change, so a quota
  failure, a write failure, a lost permission or a competing tab leaves
  either the complete import or the prior vault — never half of one. The
  store rolls its in-memory body back on a failed seal or write.

## What was NOT examined

This is the part that matters most.

- **No third-party audit.** No external review, no formal verification, no
  professional penetration test. One author, one pass.
- **No cryptographic review of the composition.** The primitives are
  maintained libraries and the platform, but nobody independently reviewed
  the way this code composes them — the Shamir implementation, the AAD
  construction, the MAC ordering.
- **No side-channel analysis.** Nothing was measured for timing or cache
  behaviour. JavaScript in a shared page is not a side-channel-resistant
  environment and this work does not pretend otherwise.
- **No browser-memory analysis.** Key material lives in JavaScript
  `Uint8Array`s. They are zeroed when an operation finishes, but a garbage
  collector may have copied them first and a JIT may keep values alive.
  This is a limitation of the platform, not something this change solves.
- **No live cloud proof.** SB-053, SB-054, SB-055 and SB-058 are
  **blocked-external**. The cloud adapters' wire encodings are unit-tested;
  no request was made to a real provider.
- **One browser engine.** The gates run headless Chromium.
- **No fuzzing of the parsers beyond the checked-in corpus.** The YAML and
  JSON parsers are the largest untrusted-input surface here and deserve a
  fuzzing pass they have not had.
- **No review of the vault store beyond the one method added.** `saveItems`
  was added and tested; the surrounding store was not re-reviewed.

## Deliberate residual risks

- **Upstream drift.** A SOPS release newer than the pin is untested. The
  pin turns drift into a gate failure, not into compatibility.
- **Cloud KMS decrypt rights are a recovery path.** Anyone who can call
  `Decrypt` on a configured key, holding the document, can recover the data
  key. That is how SOPS works and it is disclosed, not marketed away.
- **A recipient is only as private as the document.** age recipients are
  visible before unlock — deliberately, so a person can see who a document
  was addressed to before deciding to open it.

## Test material

Every identity in `apps/pages/src/lib/sops/fixtures/upstream/identities.json`
is **synthetic**, generated by `apps/pages/scripts/sops-fixtures.mjs`, and
marked as such in the file. They protect nothing and must never be used for
real data. No real vault was read, no production secret was used, no
billable cloud resource was provisioned, and no KMS key or hardware slot was
created, rotated or deleted.
