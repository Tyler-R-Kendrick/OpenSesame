# Password-manager bridges

How foreign password-manager clients reach OpenSesame, and how foreign
password-manager stores reach OpenSesame's connector host. Decisions and
rationale are in
[ADR 0052](../adr/0052-password-manager-ecosystem-bridging.md) (strategy,
planes, licence policy, roadmap) and
[ADR 0053](../adr/0053-pm-bridge-binaries.md) (crate layout, daemon
dependency budget). Enforcement invariants come from
[ADR 0005](../adr/0005-authority-handle-connectionref.md) (no agent-facing
plaintext), [ADR 0048](../adr/0048-capability-moded-connector-discovery.md)
(capability modes, dependency quarantine) and
[ADR 0049](../adr/0049-derived-short-lived-materialization.md) (password
managers never mint).

## Two directions, two topologies

The word "bridge" covers two unrelated data flows. They have different
processes, different dependencies, and different planes; keeping them
visually separate is most of the architecture.

### Direction 1 — serve their clients (inbound, local IPC)

A foreign client speaks its own protocol to a small OpenSesame binary,
which reads the sealed store in-process. No daemon, no gateway, no network.

```
 keepassxc-browser ext ──┐ stdio (native messaging: u32-LE len + UTF-8 JSON)
 browserpass ext ────────┤        ─ or ─
 gopass-jsonapi consumer ┤ UDS ($XDG_RUNTIME_DIR, opt-in, conflict-checked)
 libsecret consumer ─────┘ D-Bus session bus (stretch, opt-in)
             │
             ▼
   ┌─────────────────────────────────────────────┐
   │ apps/pm-bridges  (one [[bin]] per surface)  │
   │   keepassxc_bridge  browserpass_host        │
   │   gopass_jsonapi    secret_service*         │
   │  ── all default-off behind a cargo feature  │
   │  ── pairing check (ADR 0052 §2b) per caller │
   └───────────────────┬─────────────────────────┘
                       │ in-process (opensesame-sealed-store)
                       ▼
        crates/sealed-store  →  StoreRoot / Entry / otp / generate
                       │  git-native ciphertext tree, anti-rollback revisions
                       ▼
        ~/.password-store  (or OPENSESAME_STORE_DIR / active tomb)

   pairing state: ~/.config/opensesame/bridges/<surface>.json
                  (public keys + name + created — never secrets)
```

The one exception to "no gateway" is the **Vault KV v2 read facade**, which
is a server-API surface rather than local IPC and therefore lives on the
gateway:

```
 ESO / Terraform / bao CLI ── HTTPS + X-Vault-Token ──► apps/gateway
                                                          │ default OFF
                                                          │ (kv_facade_enabled)
                                                          ▼
                                            read view over existing gateway
                                            secret storage — no new tables
                                                          │
                                                          ▼
                                                   receipt per read
```

### Direction 2 — consume their stores (outbound, brokered)

A foreign store is an upstream. The connector host produces a declarative
plan; the CLI's async call site executes it through a provider crate. The
agent never sees the value — it holds a ConnectionRef and the Host performs
the call.

```
 agent ── ConnectionRef + Intent ──► Host API ──► crates/connector-host
                                                        │
                                                 human_plan(provider, op)
                                                        │
                    ┌───────────────────────────────────┴───────────────┐
                    ▼                                                   ▼
      HumanProviderPlan::SealedStore                 HumanProviderPlan::Command
      (in-process, no subprocess)                    (legacy: bw / op /
                    │                                 keepassxc-cli / security)
                    │                                                   │
                    ▼                    HumanProviderPlan::Bitwarden ──┤
        crates/sealed-store              HumanProviderPlan::Passbolt* ──┘
                                                        │
                          execute_human_plan() ⇒ Unavailable  (as GitHubApp does)
                                                        │
                                     async call site in apps/cli
                                                        ▼
                        crates/provider-bitwarden   crates/provider-passbolt*
                        crates/kdbx-bridge (file, not network)
                                                        │
                        session-bound, memory-resident (SecretBox + zeroize),
                        host + TLS pinned in-crate, redirects refused
```

`*` = stretch surfaces (ADR 0052 tier 2), each droppable with a green tree.

The `Unavailable`-in-sync / execute-in-async split is not a workaround: it
is the existing `HumanProviderPlan::GitHubApp` pattern, which keeps
`execute_human_plan` synchronous and dependency-light while the async
executor lives where a TTY exists to prompt for a master password.

## Plane classification

Every surface is classified before it is built, using the ADR 0052 §2 rule:
a bridge may yield plaintext **iff** (a) the caller is the same local user
session, (b) that caller identity passed a one-time human approval, and
(c) the surface is only reachable over local IPC or loopback. A surface
failing any clause is agent-plane and yields no plaintext.

| Surface | Plane | Yields plaintext? | (a) caller authn | (b) approval ceremony | (c) reachability |
|---|---|---|---|---|---|
| ConnectionRef + Intent invoke | **agent** | **No** — receipt only | Host session/grant | grant issuance | Host API |
| MCP tools (`apps/mcp-host` / `mcp-client`) | **agent** | **No** — denylisted tool names | MCP session | — | MCP |
| WIT connector world | **agent** | **No** — `secrets.get` banned | Wasm host | — | in-process Wasm |
| `opensesame pass show --reveal` | human | Yes | TTY / `--reveal` (`require_reveal`) | the human ran it | local process |
| `pass import-kdbx` | human | n/a (writes in) | TTY | the human ran it | local process |
| `pass export-kdbx` | human | Yes (plaintext-equivalent file) | TTY / `--reveal` | the human ran it | local process |
| Pages KDBX / CXF import | human | in-page only | vault unlock | the human ran it | browser, offline |
| Pages CXF export | human | Yes (file) | vault unlock | explicit export action | browser, offline |
| browserpass stdio host | human/device | Yes | stdio parent = the browser | native-messaging manifest install | stdio only |
| gopass-jsonapi stdio host | human/device | Yes | stdio parent = the browser | native-messaging manifest install | stdio only |
| keepassxc bridge — stdio mode | human/device | Yes | stdio parent + NaCl-box client key | `opensesame bridge keepassxc pair` (bounded window, fingerprint shown) | stdio only |
| keepassxc bridge — UDS mode | human/device | Yes | UDS peer-cred (same uid) + client key | same pairing ceremony | `$XDG_RUNTIME_DIR` socket, opt-in |
| Secret Service bin (stretch) | human/device | Yes | session bus, same user | explicit enable + name-conflict refusal | session D-Bus, opt-in |
| WebDAV KDBX (stretch/likely cut) | human | Yes (a KDBX file) | loopback + token | explicit enable | loopback only |
| Vault KV v2 read facade | **ops** | Yes | `X-Vault-Token` → existing session/operator validation | operator enables `kv_facade_enabled` (default off) | gateway; **receipt emitted per read** |
| Bitwarden/vaultwarden consume-client | human | Yes, to the human who unlocked | TTY master password | connection configured by its owner | outbound from `apps/cli` |
| Passbolt consume-client (stretch) | human | Yes, to the human who unlocked | TTY key passphrase | connection configured by its owner | outbound from `apps/cli` |
| Discovery probes (`connection-detect`, `cli_probe`) | device | **No** — names and presence only | daemon operator gate | — | loopback/UDS, no network |

Reading the table: the top three rows are the product's invariant and none
of the work below them changes those rows. Everything that yields plaintext
sits on a row where a human, on this machine, already could have obtained
the same value by running `opensesame pass show --reveal`.

## Why the daemon is absent from both diagrams

Deliberately. `apps/daemon` depends on none of `apps/pm-bridges`,
`crates/kdbx-bridge`, `crates/provider-bitwarden`, or
`crates/provider-passbolt`, so none of their dependencies —
`crypto_box`, `zbus`/`oo7`, `rpgp`, `reqwest`, `keepass` — enter its tree.

`scripts/daemon-deps-gate.sh` audits `opensesame-connection-detect`'s full
tree against a fixed allowlist, plus banned crates (`sqlx`, `oauth2`,
`jsonwebtoken`, `chacha20poly1305`, `task-bus`) in the daemon's manifest
and depth-1 resolved tree and in the `invoke-through` / `tailscale-authn` /
`uds-authn` trees. A workspace member the daemon does not depend on appears
in none of those, which is what makes this topology legal without amending
ADR 0048 §5 — and what makes `pnpm audit:daemon-deps` the regression alarm
if someone later wires a bridge into the daemon. Full argument in
[ADR 0053](../adr/0053-pm-bridge-binaries.md) §2.

## Acquisition modes for password-manager providers

ADR 0048's order is **MINT → INVOKE-THROUGH → IMPORT**. Password managers
sit at a fixed point in it:

| Mode | Available for PMs? | Why |
|---|---|---|
| MINT | **Never** | No provider-native short-lived derived-token path ⇒ `422 UNMINTABLE` (ADR 0049 §3). There is no fallback that decrypts a stored credential to satisfy a helper |
| INVOKE-THROUGH | Yes — the default | Session is memory-resident: `secrecy::SecretBox`, zeroized on drop, TTL-bound, never on disk, never logged, never in argv |
| IMPORT | Yes — explicit and visible | `pass import-kdbx`, Pages importers. Marked as legacy-compat in the offer UI |

Discovery stays value-blind throughout: presence and source names only, no
values, no masked prefixes, no lengths, no credential test (a test is an
oracle — ADR 0047 §2), no network in any probe.

## Egress for user-configured servers

`crates/invoke-through`'s `EGRESS_RULES` is a static table (today: one row,
`github`, exact host matching). A consume-client dials a **user-supplied**
base URL — a self-hosted vaultwarden, a company Passbolt — which a static
allowlist cannot enumerate.

These clients are human-plane, run from `apps/cli` under a TTY, against a
URL the connection's owner configured. They **pin the configured host and
TLS in-crate and refuse redirects**, mirroring invoke-through's rules
inside the provider crate rather than widening the shared table. They do
not run in the daemon and give the agent plane no new outbound path. The
invariant preserved is "an agent cannot cause a request to a host the user
did not authorize"; a human typing their own vault's URL is that
authorization. See ADR 0052 §7.

## Singleton endpoints

Three endpoints are machine-wide singletons and are never taken by default:

| Endpoint | Collides with | Policy |
|---|---|---|
| `org.freedesktop.secrets` (D-Bus name) | gnome-keyring, kwallet | Feature-gated + runtime opt-in; requested `DO_NOT_QUEUE`; on conflict, name the current owner and exit |
| `org.keepassxc.KeePassXC.BrowserServer` (UDS) | a running KeePassXC | Feature-gated + runtime opt-in; probe-connect first; takeover removes only a **verified-dead** socket. Prefer stdio mode, which avoids the singleton entirely |
| Native-messaging manifests | the vendor's own host binary | Written only by an explicit `opensesame bridge install …` — the install *is* the approval ceremony |

## Manual interop smoke test

Not automated (each step needs a third-party client), and not part of
`pnpm verify`. Run it before claiming a bridge works with real software;
record the result and the client versions in the PR.

Prerequisites: a temp sealed store with at least one entry carrying a
`url:` trailer line and a TOTP, and a workspace build with the relevant
features on (`cargo +1.88.0 build -p opensesame-pm-bridges --features …`).

1. **KeePassXC opens an exported KDBX.**
   ```bash
   opensesame pass export-kdbx --output /tmp/smoke.kdbx --reveal
   keepassxc /tmp/smoke.kdbx     # or File > Open Database
   ```
   Expect: the database opens with the export passphrase; group paths,
   usernames, URLs, notes, custom fields, and the TOTP entry are all
   present and readable. A file that only *our* reader opens is a failed
   test, not a passed one — this is the guard on the upstream crate's
   experimental KDBX4 writer.

2. **The browserpass extension talks to our host.**
   ```bash
   opensesame bridge install browserpass --browser chrome   # or firefox
   ```
   Then, in the browser, open the browserpass extension on a page whose
   host matches the entry's `url:` trailer. Expect: `configure` succeeds,
   the entry is listed, and `fetch` fills the login. Expect **no** vendor
   `browserpass-native` binary to be involved.

3. **A stock keepassxc-browser extension pairs with the bridge in stdio
   mode.**
   ```bash
   opensesame bridge install keepassxc --browser chrome     # writes the
                                                            # native-messaging manifest
   opensesame bridge keepassxc pair                          # opens the window,
                                                            # prints the fingerprint
   ```
   In the extension, click Connect. Expect: `change-public-keys` succeeds,
   the extension prompts for an association name, the printed fingerprint
   matches what the CLI showed, and after confirming, `get-logins` on the
   matching URL returns the entry and `get-totp` returns a current code.
   Then verify the refusal path: run `associate` again **without** an open
   pairing window and expect it to be rejected.

4. **`bao kv get` reads through the KV v2 facade.**
   ```bash
   # gateway started with the facade flag on (default is off)
   VAULT_ADDR=http://127.0.0.1:8787 VAULT_TOKEN=<operator token> \
     bao kv get -mount=secret <path>
   ```
   Expect: the `{data:{data,metadata}}` envelope, a receipt recorded for
   the read, and — with the flag off — a `404`, not a `401`, because the
   routes are not mounted at all.

5. **Conflict detection is honest.** With KeePassXC running, start the
   bridge in UDS mode. Expect a refusal that names the live owner, and
   expect KeePassXC's own browser integration to keep working unchanged.

Related: [ADR 0052](../adr/0052-password-manager-ecosystem-bridging.md),
[ADR 0053](../adr/0053-pm-bridge-binaries.md),
[`docs/competitors/keepass.md`](../competitors/keepass.md),
[`docs/competitors/passbolt.md`](../competitors/passbolt.md),
[`docs/competitors/1password.md`](../competitors/1password.md),
[`docs/competitors/bitwarden.md`](../competitors/bitwarden.md),
[connection-broker.md](connection-broker.md).
