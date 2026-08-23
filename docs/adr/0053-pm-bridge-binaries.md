# ADR 0053 — Bridge binaries and the daemon dependency budget

Status: Accepted
Date: 2026-08-22
Supplements: ADR 0052 (password-manager ecosystem bridging — the strategy
this ADR implements), ADR 0048 §5 (dependency quarantine), ADR 0049 §4
(helper binaries as thin clients), ADR 0037 (git sealed store)

## Context

ADR 0052 commits OpenSesame to serving foreign password-manager clients
over local IPC: a browserpass extension, a gopass-jsonapi consumer, a
stock keepassxc-browser extension, and — behind a stretch feature — a
`libsecret` caller over D-Bus. Each of those is a process that must speak
a foreign protocol and, having satisfied the ADR 0052 §2 plane test, hand
its caller plaintext from the sealed store.

The obvious place to put that is the daemon. The daemon already listens on
loopback `:18790`, already has a UDS mode, already attests peer credentials
(`crates/uds-authn`), and already has an operator token. Reaching for it is
the natural move.

It is also the move ADR 0048 §5 exists to forbid. The daemon's dependency
budget is not a style preference:

> `connection-detect` stays serde+thiserror+std; the platform keychain
> backends live in the daemon behind the injected `KeychainBackend` trait.
> The daemon's dependency budget is recorded: `secrecy`, `zeroize`,
> `hyper`, `hyper-rustls`, `nix` are permitted; **no new** `reqwest` usage
> […]; no `sqlx`, `oauth2`, `jsonwebtoken`, `chacha20poly1305`, or the
> task bus — the ADR 0047 argument against grafting the credential-exchange
> surface onto a loopback agent stands.

The bridges want exactly the dependency classes the budget refuses:
`crypto_box` (NaCl box) for keepassxc-protocol transport, `zbus` and `oo7`
for Secret Service, `rpgp` for Passbolt, `reqwest` for the consume-clients,
the `keepass` crate for KDBX. Putting any of that behind the daemon's
listener would graft a large new attack surface onto the one process that
is deliberately small.

ADR 0049 §4 already solved a structurally identical problem for the git,
docker, AWS, and kubectl credential helpers: separate thin binaries,
`apps/credential-helpers`, one crate with several `[[bin]]`s, that are
clients of the daemon rather than code inside it. That crate's whole
dependency list today is `serde`, `serde_json`, `zeroize`, plus `tempfile`
for tests. It is the shape to copy.

## Decision

### 1. `apps/pm-bridges` — one crate, one `[[bin]]` per serving surface

Local-IPC serving surfaces live in a new workspace member modelled on
`apps/credential-helpers`:

```
apps/pm-bridges/
  Cargo.toml            # one [[bin]] per surface; one cargo feature per surface:
                        #   keepassxc, browserpass, gopass, secret-service, webdav
  src/lib.rs            # shared helpers only (see decision 4)
  src/keepassxc/        # transport, proto, pairing, actions
  src/bin/browserpass_host.rs
  src/bin/gopass_jsonapi.rs
  src/bin/keepassxc_bridge.rs
  src/bin/secret_service.rs   # feature + cfg(target_os = "linux"), stretch
  src/bin/webdav_kdbx.rs      # feature, stretch
  tests/                # golden stdio/handshake tests per bin
```

Consume-clients — the other direction of ADR 0052 — are ordinary provider
crates (`crates/kdbx-bridge`, `crates/provider-bitwarden`, and the stretch
`crates/provider-passbolt`), not bins here.

### 2. The daemon gains zero dependencies, and the gate proves it

**`apps/daemon` does not depend on `apps/pm-bridges`, on
`crates/kdbx-bridge`, or on any provider crate.** The dependency arrow
points the other way or nowhere at all.

The argument that this preserves the ADR 0048 §5 budget rests on what
`scripts/daemon-deps-gate.sh` actually audits. Its scope, read from the
script rather than remembered:

1. **`opensesame-connection-detect`'s entire resolved tree** must be a
   subset of a hard-coded allowlist. The allowlist is exactly:
   `opensesame-connection-detect`, `serde`, `serde_core`, `serde_derive`,
   `serde_json`, `itoa`, `memchr`, `zmij`, `thiserror`, `thiserror-impl`,
   `proc-macro2`, `quote`, `syn`, `unicode-ident` — serde + serde_json +
   thiserror + std and their derive-macro transitives, nothing else. Any
   addition fails the gate.
2. **Banned crates** — `sqlx`, `oauth2`, `jsonwebtoken`,
   `chacha20poly1305`, `task-bus` — must not appear in:
   - `opensesame-daemon`'s **manifest** direct dependencies (read via
     `cargo metadata --no-deps`, so a banned crate is caught even on a
     target this host does not resolve);
   - `opensesame-daemon`'s **resolved depth-1** tree, both with default
     features and with `--features tailscale`;
   - the **full trees** of `opensesame-invoke-through`,
     `opensesame-tailscale-authn`, and `opensesame-uds-authn`.

That is the whole gate. It says nothing about workspace members the daemon
does not depend on, and it cannot: `cargo tree -p opensesame-daemon
--depth 1` does not enumerate crates that are not in the daemon's
dependency graph, and `cargo metadata --no-deps` for the daemon package
lists only the daemon's own manifest. **A new workspace member that the
daemon does not depend on is invisible to every check the gate performs.**

This is the fact that makes the whole bridge-binary strategy legal without
amending ADR 0048. `crypto_box`, `zbus`, `oo7`, `rpgp`, `reqwest`, and
`keepass` can all exist in this workspace, in crates with their own trees,
while the daemon's tree is byte-for-byte what it was.

The gate is also the **regression alarm**. If someone later wires a bridge
into the daemon "just to reuse the listener", the banned-crate check on the
daemon's depth-1 tree is the tripwire — and any bridge dependency that
transitively pulls `chacha20poly1305` (a realistic outcome for AEAD-using
crypto crates) fails it loudly. `pnpm audit:daemon-deps` staying green is
therefore an explicit acceptance criterion on every Rust task in this work,
not a formality.

Two honest limits of the gate, recorded so nobody over-reads it:

- The banned list is five names matched as substrings, not a size budget.
  A bridge wired into the daemon that happened to avoid all five would pass
  the gate while still violating the ADR's intent. The gate backstops the
  rule; it does not replace reading the diff.
- Passing the gate is not evidence that a new crate is fine — it is
  evidence that the daemon is unchanged. The new crate's own dependencies
  are policed by `deny.toml` and `pnpm audit:cargo-audit` / `audit:osv`.

### 3. Bridge bins reach the sealed store in-process, at the CLI's trust position

A bridge does **not** call the daemon to read a secret, and does not
introduce a new network hop. Each bin depends on `opensesame-sealed-store`
directly and opens the store in-process, exactly as `apps/cli` does today
(`apps/cli/Cargo.toml` takes `opensesame-sealed-store` as a path
dependency, and `apps/cli/src/store.rs` drives `StoreRoot`,
`init_store_key` / `unlock_store_key`, `parse_otpauth`, `generate_password`
and friends).

This is deliberate and it is the *smaller* trust claim, not the larger one:

- **Same trust position as `apps/cli`.** A bridge bin runs as the user, in
  the user's session, and can read what the user can read by running
  `opensesame pass show --reveal`. It gains no authority the human did not
  already have at that terminal.
- **No new listener, no new boundary.** ADR 0049 §4's helpers reach the
  daemon because their job is *minting*, which only the gateway can do.
  A bridge's job is reading the local sealed store, which needs no
  authority beyond the local user's — routing it through the daemon would
  add a hop, a protocol, and a second copy of the plaintext for no gain.
- **The store's own crypto is the only at-rest crypto.** Bridges never
  re-encrypt or cache store contents. Unlock material is prompted or
  supplied per session, held in `secrecy::SecretBox`, zeroized on drop,
  never written to disk, never logged, never placed in argv.
- **The ADR 0052 §2 plane test is what authorizes the read**, per bin:
  peer credentials or the stdio parent process for (a), the pairing
  ceremony or manifest install for (b), and local IPC only for (c).

### 4. `src/lib.rs` holds shared plumbing, never per-bin behavior

The shared library is deliberately thin, and every item in it is plumbing
that would otherwise be copy-pasted:

- **Native-messaging stdio framing** — 32-bit little-endian length prefix
  followed by UTF-8 JSON, the framing Chrome and Firefox define and which
  browserpass, gopass-jsonapi, and the keepassxc proxy all use.
- **`StoreAccess`** — a wrapper over `sealed_store::StoreRoot` plus root
  resolution, so every bin resolves `OPENSESAME_STORE_DIR` →
  `PASSWORD_STORE_DIR` → `~/.password-store` (and an active tomb) the same
  way `apps/cli`'s `resolve_root` does.
- **Pairing-store helpers** — read/write of the per-bridge JSON under
  `~/.config/opensesame/bridges/`.
- **Conflict-detection helpers** — probe a UDS path or a D-Bus name and
  report *live-and-owned-by* versus *dead*, so decision 5 of ADR 0052 is
  implemented once.

Per-protocol logic lives in the bin's own module. A bin never edits another
bin's file.

### 5. Pairing state on disk is public material only

`~/.config/opensesame/bridges/<surface>.json` holds, per associated
client: the client's **public** key, the human-supplied name, and the
creation timestamp. That is the whole schema.

- No secrets, no store contents, no derived keys, no session material.
- The file is an *allowlist of who has been approved*, so the worst
  outcome of it leaking is that an attacker learns which browsers the user
  paired — not a credential.
- Association is what the ADR 0052 §2(b) ceremony writes. For the
  keepassxc bridge, `associate` is refused unless a bounded pairing window
  is open, opened by an explicit human command that prints the incoming
  key's fingerprint for confirmation. A protocol message can never create
  an association on its own.

### 6. One cargo feature per bridge, all off by default

Each surface is compiled behind its own feature (`keepassxc`,
`browserpass`, `gopass`, `secret-service`, `webdav`), and the crate's
default feature set is empty. This gives three properties:

- **A default build contains no bridge at all** — the ADR 0052 §5
  default-off requirement holds at compile time, not just at runtime.
- **Stretch surfaces are droppable.** Removing a stretch bin removes a
  feature, a bin stanza, a module, and its docs row — and leaves a green
  workspace with no dangling symbols.
- **Platform-specific surfaces are honest.** `secret_service.rs` carries
  `#[cfg(target_os = "linux")]` in addition to its feature, so a macOS
  build of the whole workspace with all features on still compiles.

Every feature must build both on and off; that is a validation step, not an
aspiration.

### 7. "No new `reqwest` call sites" is daemon-scoped

ADR 0048 §5's `reqwest` clause is frequently misread as a workspace-wide
ban. It is not. Its own words: "**no new** `reqwest` usage (the daemon
already depends on reqwest for its pre-existing loopback proxies — the
budget forbids new call sites, not the existing dependency)". The subject
of that sentence is the daemon.

Provider crates that dial a network follow the existing precedent instead:
`crates/provider-openbao` is a network-dialing provider crate that depends
on `reqwest` (with `serde`, `serde_json`, `thiserror`, `async-trait`,
`chrono`, `tokio`, `url`) and has been fine for exactly the reason above —
it is not in the daemon's tree. `crates/provider-bitwarden` and the
stretch `crates/provider-passbolt` mirror that structure.

The daemon's own `reqwest` call sites are unchanged by this work, and
`pnpm audit:daemon-deps` is the check that keeps that true.

## Consequences

- **A reviewer can verify the budget claim without running anything.** The
  daemon's manifest does not name a bridge crate; the gate audits the
  daemon's depth-1 tree, `connection-detect`'s full tree, and the
  invoke-through/tailscale-authn/uds-authn trees; a crate outside all of
  those cannot appear in any of those trees. The bridges' dependencies are
  therefore budget-irrelevant by construction.
- **The daemon stays the small, boring process ADR 0047 argued for.** No
  NaCl box, no D-Bus, no OpenPGP, no KDBX parser, no new listener, no new
  protocol handler behind its operator token.
- **Blast radius is per-bin.** A bug in the keepassxc frame parser cannot
  affect the browserpass host, the daemon, or the gateway; they are
  separate processes with separate dependency trees, and a crash takes down
  one bridge.
- **The trade accepted:** several small binaries instead of one process,
  which means several install paths, several manifests, and a slightly
  larger `target/` — paid deliberately in exchange for the daemon's
  dependency surface staying fixed. `apps/credential-helpers` already made
  this trade and it has held.
- **A bridge is as trusted as the user's own shell, and no more.** Reading
  the sealed store in-process is the same authority as
  `opensesame pass show --reveal`; what gates it is the ADR 0052 §2
  ceremony, which is where review attention belongs.
- **`pnpm audit:daemon-deps` is now load-bearing for this work.** It is the
  single command that detects the most likely future mistake — someone
  wiring a bridge into the daemon for convenience — and it must be run and
  green on every change in this area.
