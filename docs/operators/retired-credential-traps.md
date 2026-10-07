# Retired credential traps in the PWA

Open Settings → Security → Decoy → Retired passwords. Unlock the
real vault first. New PWA vaults use a passkey or PIN. Retired-password enrollment applies only to an existing vault with one verified password protector and no additional authentication step; it never creates a password protector. Existing traps remain visible after adding other protectors, but their management requires a supported fresh owner ceremony. Enroll only a selected formerly valid password, supply the
current password for fresh owner authentication, and acknowledge the retained
password verifier risk. Keep the default record-and-reject response unless you
want an isolated synthetic decoy. Remove traps when they are no longer useful.

A match records `retired_credential_observed`; stale autofill, backups and the
owner can cause it. It does not confirm an attacker. Review local observations
from the real vault. Clearing evidence requires current owner authentication.
The same bounded local history records synthetic edits and denied authority
requests. Opening the management sheet refreshes evidence saved by another tab.
Matches never wipe, freeze or fence the device or other real tabs. A mistaken
decoy is ephemeral: lock it and authenticate with the current credentials before
saving real secrets. No in-place upgrade is supported.

The decoy contains synthetic data and cannot use production connectors, Host or
Identity sessions, federation, exports, project changes or WebMCP authority.
It does not make an expired third-party password valid at that service. No fake
API key is externally observable without a controlled validator. Instrumented
canaries record local evidence; external delivery requires separate receiver
configuration. Local evidence has no independent trust or guaranteed delivery.
Treat collected activity as hostile input when reviewing it with an agent.

Installed and offline PWAs have the same browser trust limits. Storage eviction,
restored profiles, changed source and service workers can prevent observation
or deception. An attacker inspecting storage can test the separate password
verifier offline, especially relevant to two-secret protection. This is not
honey encryption. Old snapshots and previously exposed plaintext stay exposed;
if a snapshot can recover a reused vault key, rotate that key through the
appropriate recovery process. Password changes alone do not fix key exposure.

Locking a synthetic session does not restore production access. The tab stays
restricted until fresh authentication to the original owner vault completes,
including its required factors. The sealed tab context survives a normal reload;
other tabs remain usable. Creating a new vault or guest session does not replace
that proof. Production session, connector and grant getters stay hidden while
authentication is pending. If a connected second-factor service is unavailable,
its challenge fails without admitting production authority.

See [ADR 0181](../adr/0181-retired-credential-traps.md).

## Native sealed-store CLI

The native `opensesame pass` store uses its own versioned key manifest and vault
identity; its trap records are scoped to that identity, not imported silently
from a PWA tomb. In a human terminal, run:

```sh
opensesame pass security retired enroll --acknowledge-verifier-risk --path /path/to/store
opensesame pass security retired enroll --response synthetic-decoy --acknowledge-verifier-risk --path /path/to/store
opensesame pass security retired status --path /path/to/store
opensesame pass security retired remove TRAP_ID --path /path/to/store
opensesame pass security retired clear-events --path /path/to/store
```

Enrollment prompts separately for the current and selected retired passphrases;
secrets are not command arguments. Management requires fresh current-password
verification and a human terminal. Older legacy key files must first be migrated
to a versioned manifest. The native verifier uses the same exact UTF-8 Argon2id
parameters and public conformance vectors as the PWA.

Ordinary `pass show`, `pass ls`, and `pass find` use typed read admission when
traps are enrolled. A selected synthetic match sees only `Example/account` and
synthetic fields at a reserved `.invalid` address. The independent synthetic
realm has no production `ItemDataKey`; mutations, backup, attachment sync and
exports do not receive a real key from that credential. Each native command is
a new invocation, so returning to real data means supplying the current password
on a new command. A decoy read cannot upgrade itself. Native store filenames were
already filesystem metadata; this feature does not encrypt that existing layout.

The bounded local record file is `.opensesame-retired-credentials.json`. It
contains only selected salted verifiers and bounded events. A hostile or corrupt
file is refused rather than silently skipping recognition. Back up configuration
with its matching vault identity, and use fresh owner authentication when
removing traps or clearing evidence. These local observations still do not prove
an attacker, deliver independent alerts, or repair old snapshots/key reuse.

Native sealed-store trap persistence currently requires Unix file locking and
descriptor-based confinement. On other platforms, enrolling or opening retained
trap records fails closed; stores without trap records retain their existing
behavior. This restriction applies to the Rust sealed-store CLI, not the mobile
application gate's separate protected-storage adapter. Windows lock and reparse
point behavior has not been validated.

Trap updates write a private sibling file, sync it, rename it atomically, then
sync the directory. An interrupted pre-publication update keeps the last complete
record. A process crash can leave a `.retired-pending-*` file containing only
bounded verifier metadata; remove those orphan files after closing store writers.
Both matched authentication and owner management refuse nonregular record nodes,
oversized or malformed records, and concurrent key-file edits. Enrollment rejects
non-NFKC spellings; matching never normalizes or accepts password variants.

## Browser extensions

Both extensions share the core classifier and synthetic-vault construction.
Open Security settings in the main extension's options page, or Security in the
autofill companion popup. Set a device-local vault password, unlock it, then
select a retired password and acknowledge the retained-verifier risk. The
extension vault is scoped to that installation's origin; it does not silently
share another extension's or the PWA's password configuration.

A protected installation requires fresh real authentication before production
runner, pairing or autofill operations. The background worker mints a short-lived
permit for that page's live browser port. Synthetic permits cannot authorize
production operations, even when copied into a direct runtime message. Lock,
port disconnection, worker restart, expiry and password-header changes invalidate
real permits. A synthetic session does not disable another owner's already
admitted real page or independently consented runner jobs. Content-script fill
requests retain their original origin/frame/nonce restrictions and the real
initiating permit is rechecked before retrieving or returning a value.

Lock the example vault and enter the current password to return to real data.
Synthetic notes are temporary; do not save real secrets in them. Local observation
history can be reviewed and cleared only from the real Security panel with fresh
owner proof. Existing device-sealed runner credentials and ambient browser
sessions keep their original device trust boundary: an attacker who can modify
extension code or storage can bypass local reporting and UI restrictions. The
new worker protocol does not claim to protect those existing device credentials
against complete extension compromise.

## Controlled canaries and independent CLI detectors

Canaries use random identifiers, synthetic responses and fixed observation
semantics. They contain no production account credentials. Creating a bait
artifact is different from retiring a production identifier: retirement must
resolve a record from an actual configured issuer. An arbitrary pasted token
cannot establish prior authority. Browser runtime lease inventory is local to
that running application and disappears on reload.

The human client CLI exposes management with fresh owner authentication:

```sh
opensesame-id security canary status
opensesame-id security canary create --kind connection_ref --output ./private-canary.json
opensesame-id security canary export-mcp --output ./private-mcp-canary.json
opensesame-id security canary retire ISSUER_RECORD_REF
opensesame-id security canary remove ARTIFACT_ID
opensesame-id security canary clear-events
```

Private exports contain the presented canary identifier and are intentional bait
artifacts. Keep the owner copy private. The enrolled registry contains its
context-bound digest, not the identifier. These digests are not password
verifiers. Kinds are `connection_ref`, `mcp_configuration`, `token_generation`
and `agent_lease`; a bait kind alone does not make it a formerly valid token.

An MCP export from the browser must be explicitly installed in the CLI
environment that will run its detector:

```sh
chmod 600 ./private-mcp-canary.json
opensesame-id canary install --config ./private-mcp-canary.json --trust-configuration
opensesame-id canary serve --config ./private-mcp-canary.json
opensesame-id canary events --config ./private-mcp-canary.json
opensesame-id canary uninstall --config ./private-mcp-canary.json
```

The detector exposes only a synthetic status tool. It does not unlock or import
the owner's real vault. In a browser export, replace the `<config-file>`
placeholder with the actual file path before configuring an MCP client. The
detector retains observations in its own CLI environment; they do not appear
automatically in the browser. Removing the browser artifact does not uninstall
an independently installed detector. Uninstall it where it runs; old
configurations then fail closed.

## Optional sealed receiver

Use local-only evidence unless you have provisioned a receiver under your
control. Review its destination and obtain its private pairing file through a
trusted channel. The file contains independent secret delivery material: do not
put its contents in command arguments, logs, issue reports or screenshots.

```sh
opensesame-id security receiver configure ./private-pairing.json --confirm-destination
opensesame-id security receiver test
opensesame-id security receiver enable
opensesame-id security receiver status
opensesame-id security receiver disable
opensesame-id security receiver remove
```

Configuration starts disabled. A real authenticated acknowledgement is required
before enabling delivery. An HTTP success without that acknowledgement is a
failure. Delivery sends sealed, bounded event metadata to one fixed route,
without cookies, production tokens or redirects. Failed delivery leaves local
detection intact. Offline delivery is best effort; packages expire after 24
hours and stop after five attempts. The bounded outbox and hourly budget can
suppress additional remote observations while local detection continues.
Disable or remove discards unsent packages. Already dispatched requests cannot
be retracted. A receiver needs its own availability, storage and TLS operations;
the offline PWA does not provide those services automatically.

## Native human canary and receiver controls

The native `opensesame` CLI requires a human terminal and a fresh current store
password for management. Passwords and pairing material are never arguments.
Local creation supports `connection-ref` and `mcp-configuration` bait. It does
not turn arbitrary tokens into previously issued credentials.

```sh
opensesame pass security canary create --kind connection-ref --path /path/to/store
opensesame pass security canary create --kind mcp-configuration --path /path/to/store
opensesame pass security canary status --path /path/to/store
opensesame pass security canary export-validator ARTIFACT_ID --output-file ./private-binding.json --path /path/to/store
opensesame pass security canary remove ARTIFACT_ID --path /path/to/store
opensesame pass security canary clear-events --path /path/to/store
```

Creation returns the random bait identifier once and, for MCP, a runnable
configuration. Keep the owner copy private. Export-validator additionally asks
for that selected identifier through hidden input; its private output contains
only a digest binding. It contains neither the identifier nor a real vault root.

Install exported metadata explicitly in an existing owner-private directory:

```sh
mkdir -m 700 ./private-detector
opensesame canary install --directory ./private-detector --binding-file ./private-binding.json --approve-vault-identity VAULT_ID
opensesame canary status --directory ./private-detector --validator-id VALIDATOR_ID
opensesame canary uninstall --directory ./private-detector --validator-id VALIDATOR_ID
```

Configure an MCP client to run `opensesame canary serve --directory
./private-detector --validator-id VALIDATOR_ID`, with the separately retained
bait in `OPENSESAME_CANARY_TOKEN`. This is intentionally a detection credential,
not a production password. The installed detector has no real store key. It
accepts at most 64 messages of at most 4 KiB and exposes only `canary.status`.
Removing the original artifact does not uninstall a separately installed copy.

Actual issued retirement requires an independently authorized, configured Host:

```sh
opensesame --server https://host.example pass security canary retire-issued ISSUER_RECORD_UUID --path /path/to/store
```

The UUID must identify an actual Host issuance. The Host requires its existing
native owner/admin authorization and fresh step-up, or configured operator
authorization. The current store password proves local management only; it is
never sent to the Host. The adapter calls the fixed retirement route, refuses
redirects and unbounded responses, then re-proves the current local owner before
importing the authenticated retired digest. Explicit `--allow-loopback` permits
a configured strict loopback HTTP Host for local deployments.

Pairing and delivery use the same independently sealed observation protocol:

```sh
opensesame pass security receiver configure --provision-file ./private-pairing.json --path /path/to/store
opensesame pass security receiver test --path /path/to/store
opensesame pass security receiver enable --path /path/to/store
opensesame pass security receiver status --path /path/to/store
opensesame pass security receiver disable --path /path/to/store
opensesame pass security receiver remove --path /path/to/store
opensesame pass security receiver flush --path /path/to/store
```

Configuration starts disabled/unverified. A genuine current-binding HMAC ACK,
and unchanged original owner manifest, are required to verify a delivery test.
A separate fresh owner action enables delivery. Pairing imports require private
regular files; symlinks, multiple links, broad permissions and oversized inputs
are refused. Flush is detection-only and reports delivered/queued/failed counts
without opening the real root. It attempts at most two deliveries, four seconds
each. Registered MCP observations kick the same bounded sender outside root edit
locks. Disabled/revoked bindings discard unsent observations; already dispatched
requests cannot be recalled. Local evidence and production rejection do not
require the receiver.

These native CLI detector/pairing files currently use the POSIX owner-private
software adapter. Unsupported native platforms fail closed rather than infer
Windows ACL protection from POSIX mode bits. Device-file protection is not
hardware-backed protection or an independent boundary against device takeover.
