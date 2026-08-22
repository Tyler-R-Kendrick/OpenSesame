# ADR 0052 — Password-manager ecosystem bridging

Status: Accepted (strategy; roadmap rows are explicitly not built)
Date: 2026-08-22
Supplements: ADR 0005 (ConnectionRef over SecretRef), ADR 0017 (host/client
topology), ADR 0037 (git sealed store), ADR 0047 / ADR 0048 (connector
discovery and capability modes), ADR 0049 (derived short-lived
materialization), ADR 0051 (independently feature-gated, default-off
protocol adapters)
Mechanics: ADR 0053 (bridge binaries and the daemon dependency budget)

## Context

Vaultwarden is beloved for one structural reason: it re-implements
Bitwarden's *server* API, so every polished Bitwarden client — desktop,
mobile, browser extension — works against a server the user runs. The
network effect belongs to the protocol, not to the product that first
shipped it.

OpenSesame wants that effect across more than one ecosystem, in both
directions:

1. **Serve their clients.** A stock keepassxc-browser extension, a
   browserpass extension, a `libsecret` consumer, or an ops tool that
   speaks Vault KV v2 should work against OpenSesame unchanged.
2. **Consume their stores.** A user's Bitwarden/vaultwarden account,
   Passbolt instance, or KeePass database should plug in as an upstream
   the Host brokers behind ConnectionRef + Intent.

Today the second direction exists only as outbound CLI shelling.
`crates/connector-host/src/providers.rs` `human_plan()` returns declarative
`HumanProviderPlan` values that shell `bw list items --raw`,
`keepassxc-cli show`, `op read`, and macOS `security`; only
`password-store`/`sealed-local` run in-process through
`HumanProviderPlan::SealedStore`. That is fragile (it depends on the
vendor's binary, its login state, and its output format) and it is not a
bridge — it is a subprocess.

The first direction does not exist at all, and it is the one that carries
the real risk. Every serving surface worth having is a surface that hands
its caller *plaintext*: Secret Service returns a secret to `libsecret`,
keepassxc-protocol `get-logins` returns credentials for autofill, a KV v2
read returns cleartext JSON. OpenSesame's founding invariant is that there
is no `getSecret()` (ADR 0005). Without an explicit rule, "bridge the
ecosystems" is indistinguishable from "add the affordance the product was
built to refuse."

This ADR is the strategy: what we bridge, on which plane, under which
licence stance, and what we deliberately do not build. ADR 0053 is the
mechanics.

## Decision

### 1. Three kinds of compat surface, named and treated differently

Compatibility work is classified before it is scheduled, because the three
kinds have different cost, different licence exposure, and different plane.

| Kind | What it is | Cost shape | Examples |
|---|---|---|---|
| **File-format** | Read/write a documented container | Bounded; a parser and a mapping | KDBX 4.x, FIDO CXF, `.1pux`, Bitwarden/Proton/1Password JSON+CSV exports |
| **Server-API** | Impersonate a vendor's server so their clients connect | Unbounded; a whole product's wire surface plus its release treadmill | Vault KV v2 facade (now); Bitwarden server API, Passbolt server API (roadmap) |
| **Local-IPC** | Speak a desktop/browser protocol over a local socket, stdio, or bus | Moderate; one protocol, one process, no hosting | keepassxc-protocol, Secret Service, browserpass / gopass native-messaging hosts |

**File-format and local-IPC are where the leverage is.** They buy real
client compatibility for weeks of work, they carry no ongoing conformance
obligation to a vendor's release train, and they are strictly local. Full
server-API impersonation buys the most and costs the most, so it is
roadmap with named caveats (decision 4) rather than an aspiration.

### 2. The plane-classification rule (the decision that makes this safe)

Every plaintext-yielding bridge is classified before it is written. The
rule, stated as the branch constitution states it:

> A bridge may yield plaintext to its caller **iff all three hold**:
> (a) the caller is authenticated as the *same local user session* (UDS
> peer-cred, stdio parent process, or loopback + user/operator token);
> (b) each distinct caller identity required a one-time explicit human
> approval (a pairing ceremony analogous to `opensesame device approve`);
> (c) the surface is reachable only via local IPC or loopback, never
> remotely and never from the agent plane. The mental anchor is
> `opensesame pass show --reveal` with a protocol adapter bolted on front.

A surface satisfying (a), (b), and (c) is **human-plane or device-plane**
(ops-plane for the KV v2 facade, which an operator runs for ESO/Terraform/CI
and which additionally emits a receipt per read). A surface failing any of
the three is agent-plane and **must not** yield plaintext, no matter how
convenient the protocol makes it look.

Three notes on the anchor:

- (b)'s ceremony in this repo is the same *shape* as the existing device
  approval (`POST /api/v1/device/approve`) — an out-of-band human act that
  admits one named caller — not a literal reuse of that endpoint. The
  keepassxc bridge's ceremony is `opensesame bridge keepassxc pair`, which
  opens a bounded window and prints the incoming key fingerprint for human
  confirmation; the browserpass/gopass hosts' ceremony is the explicit
  native-messaging manifest install.
- The anchor is exact, not rhetorical. `opensesame pass show --reveal`
  already yields plaintext to a human on a TTY, gated by `require_reveal`
  (`apps/cli/src/store.rs:17`), which refuses non-TTY output with "agents
  must use ConnectionRef invoke". A bridge is that same act with a wire
  protocol in front of it, so it inherits the same gate rather than
  inventing a weaker one.
- **ADR 0005 and ADR 0017 are unaffected.** No bridge adds a `getSecret`,
  `materialize`, `reveal`, `show`, `pass_show`, or `password_store_read`
  affordance to any MCP tool list or WIT world. The structural guards stay
  as they are: the `secrets.get` ban in `wit/connector/world.wit`, the
  tool-name denylists in `apps/mcp-host` / `apps/mcp-client`, and
  `assert_opaque_sync_json`. The agent plane's answer is unchanged —
  ConnectionRef → authorize → invoke → receipt.

Structurally: a bridge is a separate binary, reachable only over local IPC
or loopback, that is not linked from the gateway's agent routes, not
exposed as an MCP tool, and not importable from a WIT world. It cannot be
reached from the agent plane because there is no path, not because a check
says no.

### 3. Licence policy

The distinction that governs everything below: **implementing a protocol
or file format from its public specification is not a derivative work of
any implementation of it.** Copying source is. Every ecosystem we bridge
has at least one GPL/AGPL implementation, and none of that source enters
this repo.

| Category | Stance | Enforcement |
|---|---|---|
| Public specs and documented wire formats (KDBX, keepassxc-protocol, Secret Service, native messaging, Vault KV v2 HTTP API, FIDO CXF, Bitwarden/Passbolt public API docs) | **Implement freely** | Review |
| Permissively licensed dependencies (MIT / Apache-2.0 / BSD / ISC / MPL-2.0) | **Depend freely** | Mechanical — `deny.toml` `[licenses].allow` lists MIT, Apache-2.0 (+ LLVM-exception), BSD-2/3-Clause, ISC, Unicode-3.0, Unicode-DFS-2016, Zlib, CC0-1.0, MPL-2.0, OpenSSL, CDLA-Permissive-2.0 and **no GPL or AGPL**, so `cargo deny check` fails a contaminating dependency before review does |
| MIT/ISC reference implementations | **Fork/derive with attribution** in `NOTICE`, or study | Review |
| AGPL/GPL codebases — vaultwarden (AGPL-3.0), Bitwarden clients (GPL-3.0), KeePassXC (GPL-2.0/3.0), Passbolt (AGPL-3.0) | **Study-only, clean-room.** Read the spec and the observable protocol; never paste, port, or transliterate the source | Review; `deny.toml` catches any attempt to depend on them |

Sanctioned dependencies and references for this work:

| Dependency / reference | Licence | Stance |
|---|---|---|
| `keepass` crate (Rust KDBX) | MIT | Permissive dependency, pinned. KDBX4 **write** is experimental upstream, which is why the KDBX writer is constrained to KDBX 4.0 / AES-256 or ChaCha20 / Argon2id and guarded by a cross-implementation conformance fixture |
| kdbxweb (TS KDBX) | MIT | Permissive dependency (pages adapter), lazily imported |
| hash-wasm | MIT | Permissive dependency — supplies Argon2 to kdbxweb via `CryptoEngine.setArgon2Impl`; pages has no Argon2 of its own |
| `crypto_box` (RustCrypto NaCl box) | MIT OR Apache-2.0 | Permissive dependency — keepassxc-protocol transport crypto |
| rpgp | MIT OR Apache-2.0 | Permissive dependency — OpenPGP for the Passbolt consume-client |
| oo7 | MIT | Fork/derive or depend, with attribution — Secret Service client *and* server |
| rbw (Rust Bitwarden client) | MIT | **Fork/derive with attribution.** It is in maintenance mode, so it is a source of verified protocol knowledge, not a dependency to take |
| browserpass-native | ISC | **Reference only** — reimplement the JSON stdio protocol; do not vendor |
| vaultwarden, Bitwarden clients, KeePassXC, Passbolt | AGPL-3.0 / GPL-3.0 | **Study-only, clean-room** |

**Why the Bitwarden-family stance is deliberately hedged.** In 2024
Bitwarden made its client `sdk-internal` proprietary under a licence
carrying a field-of-use restriction aimed squarely at vaultwarden-class
projects, while clients had a build-time dependency on it — briefly making
the "just build the GPL client" answer untrue. The episode was resolved in
November 2024 by splitting the SDK: `sdk-internal` under GPL-3.0 and
`sdk-secrets` under the Bitwarden License. The lesson is not that
Bitwarden behaved badly; it is that **a vendor can move the licence under a
compat strategy that is built on their code path**. Bitwarden compatibility
is therefore one adapter among several in this ADR and never the
foundation. If the Bitwarden ecosystem became unbridgeable tomorrow, KDBX,
CXF, the local-IPC surfaces, and the KV v2 facade would all still stand.

### 4. Tiers and roadmap

| Tier | Surface | Kind | Plane | State |
|---|---|---|---|---|
| 1 | KDBX 4.x read/write (`crates/kdbx-bridge`) + `opensesame pass import-kdbx` / `export-kdbx` | file-format | human | Built |
| 1 | KDBX import in Pages (binary import pipeline + adapter) | file-format | human | Built |
| 1 | FIDO CXF import **and** export in Pages | file-format | human | Built |
| 1 | browserpass-native stdio host | local-IPC | human/device | Built |
| 1 | gopass-jsonapi stdio host | local-IPC | human/device | Built |
| 1 | keepassxc-protocol bridge (stdio native-messaging host, plus opt-in UDS mode); passkeys deferred | local-IPC | human/device | Built |
| 1 | Vault KV v2 **read** facade on the gateway, default off, receipt per read | server-API | ops | Built |
| 1 | Bitwarden/vaultwarden **consume**-client (`crates/provider-bitwarden`) behind ConnectionRef | client | human | Built |
| 2 | Passbolt **consume**-client (`crates/provider-passbolt`) | client | human | Stretch — droppable |
| 2 | `org.freedesktop.secrets` D-Bus server | local-IPC | human/device | Stretch — droppable |
| 2 | keepassxc-protocol passkey actions | local-IPC | human/device | Stretch — droppable |
| 2 | KDBX-over-WebDAV serving (KeePass `File > Synchronize > With URL`) | server-API | human | Stretch — likely cut |
| **R** | **Bitwarden server API compat** (serving Bitwarden's own clients) | server-API | — | **Roadmap — not built** |
| **R** | **Passbolt server API compat** (serving Passbolt's own clients) | server-API | — | **Roadmap — not built** |
| **R** | CXP / HPKE credential-exchange *transport* (the protocol half of CXF) | server-API | — | **Roadmap — not built** |
| **R** | Bitwarden Secrets Manager server API | server-API | — | **Roadmap — not built** |

Roadmap rows exist here so the cost is recorded rather than rediscovered.

**Bitwarden server API compat — 3–6 engineer-months, with hard external
dependencies.** Serving Bitwarden's own clients means:

- An ASP.NET **SignalR hub at `/notifications/hub`** speaking the
  MessagePack protocol, because clients open it for live sync. This is not
  a REST endpoint; it is a framing protocol with a handshake and a
  transport negotiation, and it is a distinct build from the vault API.
- **Strict EncString conformance.** Clients from 2026.4.0 onward parse
  EncStrings through a strict Rust WASM SDK rather than the older lenient
  JS paths. This is exactly the change that broke vaultwarden until its
  1.37.0 release. A compat server now inherits a conformance obligation to
  someone else's release train, and an off-by-one in a padding or MAC path
  is a client-side data-loss bug, not a 400.
- **Mobile push requires a Bitwarden-issued push-relay installation ID**
  obtained from `bitwarden.com/host`. There is no self-hosted substitute:
  the vendor's relay is in the path, so a self-hosted compat server's
  mobile notifications are an *unremovable dependency on the incumbent*.
  This is the single strongest argument for not making Bitwarden
  compatibility the foundation of the strategy.
- **Landing zone, when it is built.** The server-side E2EE item store is
  already migrated but unwired: `vaults`
  (`migrations/0001_init.sql:140`) and `encrypted_item_revisions`
  (`migrations/0001_init.sql:147`), with
  `Db::insert_encrypted_item` (`crates/storage/src/lib.rs:471`). Verified
  today: `insert_encrypted_item` has **no callers at all**, and
  `encrypted_item_revisions` is read only by
  `Db::list_encrypted_item_revisions` (`crates/storage/src/lib.rs:925`),
  which serves the ADR 0039 backup snapshotter
  (`apps/gateway/src/backup.rs:299`). Any future compat server stores
  opaque client ciphertext there and adds no schema.

**Passbolt server API compat — 2–4 engineer-months, with a structural
scaling property and a version cliff.** Passbolt is per-user OpenPGP: every
secret is stored once per user, encrypted to that user's key. Sharing a
resource with N users is therefore **O(N) client-side re-encryption**, not
a server-side ACL write — a property that shapes the whole server, not a
detail of it. Passbolt v5 additionally encrypts resource *metadata*, not
just secret values, which is a **compat cliff**: a v4-shaped compat server
does not become a v5 one incrementally. The consume-client (tier 2) detects
v5 metadata encryption and refuses with a named error rather than guessing.

**CXP/HPKE transport** — CXF (the format) is a Proposed Standard as of
August 2025 and is implemented here; CXP (the HPKE-based direct
device-to-device transport) targets 2026 and is not.

**Bitwarden Secrets Manager API** — noted because it is *uncontested*:
vaultwarden does not implement it, so a Secrets Manager-compatible surface
would be the first. That makes it interesting, not urgent; the catalog
already carries `bitwarden-sm` as a configuration-only connector row.

### 5. Exclusive-ownership endpoints are opt-in, default off, and never stolen

Three of the local-IPC surfaces claim endpoints that are **singletons on
the machine**:

| Endpoint | Owner it collides with |
|---|---|
| `org.freedesktop.secrets` (D-Bus well-known name) | gnome-keyring, kwallet |
| `org.keepassxc.KeePassXC.BrowserServer` (UDS socket in `$XDG_RUNTIME_DIR`) | a running KeePassXC |
| Native-messaging host manifests (`org.keepassxc.keepassxc_browser`, browserpass, gopass) | the vendor's own host binary |

Policy, following ADR 0051's precedent that new protocol families ship as
independently feature-gated, default-off adapters:

1. **Compiled behind a per-surface cargo feature**, off by default.
2. **Disabled at runtime** until an explicit user action enables it —
   installing the manifest, or running the bridge with the flag.
3. **Conflict detection before binding.** Probe the endpoint; if it is
   live, refuse with a diagnostic that *names the current owner* ("a live
   KeePassXC owns this socket", "gnome-keyring owns
   `org.freedesktop.secrets`") and exit. D-Bus names are requested
   `DO_NOT_QUEUE`.
4. **Never steal a live endpoint.** A takeover flag removes only a
   **verified-dead** socket, and it is never the default.
5. **Prefer the non-singleton mode.** The keepassxc bridge's recommended
   install is stdio native-messaging-host mode, which avoids the socket
   singleton entirely; UDS mode is the opt-in alternative.

Silent endpoint capture would break the user's existing password manager
in a way that looks like the *other* product failing. That is the failure
mode this policy exists to prevent.

### 6. Acquisition modes: password managers never mint

ADR 0048 fixes the acquisition preference as **MINT → INVOKE-THROUGH →
IMPORT**. Password managers sit at a specific point in that order and it
does not move:

- **Never MINT.** A password manager has no provider-native short-lived
  derived-token path. Under ADR 0049 §3 a provider with no native mint
  path answers **`422 UNMINTABLE`** and is never offered helper mode. There
  is no fallback that decrypts a stored credential to satisfy a helper, and
  a PM bridge does not create one.
- **Consume is INVOKE-THROUGH class.** A native consume-client's session
  (Bitwarden user key, Passbolt session, a decrypted KDBX) is
  **session-bound and memory-resident**: held in `secrecy::SecretBox`,
  zeroized on drop, TTL-bound, never written to disk, never logged, never
  passed in argv. Master passwords and key passphrases are prompted on a
  TTY at the human-plane call site and never persisted anywhere.
- **Or an explicit, visible IMPORT.** `pass import-kdbx` and the Pages
  importers move items once, under a human action, and say so. IMPORT is
  legacy-compat and is marked as such.
- **Discovery stays value-blind.** Anything added to
  `crates/connection-detect` or the daemon's `cli_probe.rs` reports names
  and presence only — no values, no masked prefixes, no lengths, and **no
  "test this credential" step, because a test is an oracle** (ADR 0047 §2).
  No probe touches the network. Where a vendor's liveness check cannot be
  proven local-only, the probe degrades to presence-only and records why in
  a comment.

### 7. Egress for user-configured servers (read this before calling it a bypass)

`crates/invoke-through`'s `EGRESS_RULES` is a **static** table restated
from the broker catalog; today it holds exactly one row (`github`, hosts
`api.github.com` and `uploads.github.com`, `AuthStyle::Bearer`), with
exact case-insensitive host matching and no wildcards.

A Bitwarden or Passbolt consume-client dials a **user-supplied base URL** —
`https://vault.bitwarden.com`, a self-hosted vaultwarden on a tailnet, a
company Passbolt. A static allowlist cannot enumerate those hosts, and it
should not try: enumerating them would mean shipping a list of every
self-hosted deployment in the world.

The resolution is stated here explicitly so no reviewer reads it as a hole:

- These clients are **human-plane clients**, not the daemon's brokered
  egress path. They run in `apps/cli` under a TTY, against a URL the human
  configured on the connection.
- They **pin the configured host and TLS in-crate** and **refuse
  redirects**, mirroring invoke-through's rules inside the provider crate
  rather than inheriting them from `EGRESS_RULES`. A response that
  redirects off the configured host is an error, not a hop.
- They **do not widen `EGRESS_RULES`**, do not run in the daemon, and do
  not give the agent plane a new outbound path. The agent plane's egress
  story is unchanged.

The invariant being preserved is "an agent cannot cause a request to a host
the user did not authorize." A human typing their own vault's URL into
their own CLI is the authorization.

### 8. Product stance

`PRODUCT.md` says OpenSesame is "not a Bitwarden replacement." That stays
true and gets sharper: **OpenSesame is not a hosted Bitwarden service; it
is a bridge for Bitwarden-family clients and stores.** We do not sell a
consumer password vault, we do not clone anyone's brand, and we do not
promise to be someone's sync product. We do speak their formats and their
local protocols, so the tools a person already loves keep working while the
authority model underneath becomes ConnectionRef + Intent.

## Consequences

- **The `getSecret()` invariant survives contact with the protocols that
  most want to violate it.** Every plaintext-yielding surface is a separate
  local binary behind a pairing ceremony, with no agent-plane path in.
  Decision 2 is the sentence a reviewer applies to any future bridge
  proposal; a surface that cannot satisfy all three clauses is not built.
- **Compatibility is achieved without depending on any single vendor.**
  KDBX and CXF are formats nobody can revoke; the local-IPC protocols are
  documented and stable; the KV v2 facade is a read view over storage we
  already own. If any one vendor's ecosystem closes, the rest stand.
- **Licence contamination is a mechanical failure, not a judgement call.**
  `deny.toml`'s permissive-only allowlist means a GPL/AGPL dependency fails
  `cargo deny check` before it reaches review. The residual risk is a human
  pasting source, which is why the study-only list is explicit and why
  MIT-derived work carries `NOTICE` attribution.
- **The expensive things are recorded as expensive.** Bitwarden server
  compat's SignalR/MessagePack hub, strict-WASM-SDK EncString conformance,
  and the vendor push-relay installation-ID dependency are written down
  with their costs, so the next person to propose "just do what vaultwarden
  does" starts from the estimate instead of from enthusiasm. The unwired
  `vaults` / `encrypted_item_revisions` tables are the recorded landing
  zone, which means the roadmap row does not imply a migration.
- **Singleton conflicts become named diagnostics.** The worst outcome —
  OpenSesame silently taking `org.freedesktop.secrets` and the user's
  keyring appearing to break — is structurally excluded by decision 5.
- **Password managers are permanently outside helper mode.** `422
  UNMINTABLE` is the honest answer and stays the answer; the PM story is
  invoke-through and import, exactly as ADR 0048/0049 already decided.
- **New maintenance surface.** Each bridge is a protocol we now track: a
  keepassxc-protocol action added upstream, a KDBX 4.2, a CXF revision.
  This is bounded by the tier table — tier 1 surfaces are maintained, tier
  2 surfaces are droppable, and roadmap rows are not maintained because
  they do not exist.

Mechanics — crate layout, why the daemon dependency budget is untouched,
and how the bridge binaries reach the sealed store — are in
[ADR 0053](0053-pm-bridge-binaries.md). Topology and the plane table are in
[`docs/architecture/pm-bridges.md`](../architecture/pm-bridges.md).
