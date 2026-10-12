# ADR 0150 — Surrogate credentials at the last hop

- Status: Proposed. The core (§2–§5), the reflection fix (§4) and the proxy
  adapter (§6.1, `crates/surrogate-proxy`, an optional plugin binary with the
  §6.3 login substitution behind its own switch) have landed.
- Numbering: drafted as 0148, then 0149; renumbered to 0150 when `main` took
  0148 (the Bitwarden bridge) and 0149 (nothing stored in the clear). Branch
  names under `adr0148/` and `adr0149/` refer to this ADR.
- Date: 2026-09-28
- Builds on:
  - [ADR 0005](0005-authority-handle-connectionref.md): ConnectionRef, not SecretRef. Its §5 says "not a generic string replacer".
  - [ADR 0048](0048-capability-moded-connector-discovery.md): invoke-through, D6/D7.
  - [ADR 0049](0049-derived-short-lived-materialization.md): the mint path.
  - [ADR 0080](0080-security-event-hooks.md): one security feed.
  - [ADR 0081](0081-live-session-observation.md): sandboxed runs.
- Amends:
  - [ADR 0006](0006-env-spec-delivery-modes.md): "MITM proxy is non-goal" becomes §6.1 of this ADR.
  - [ADR 0076](0076-autonomous-web-login-rotation.md) §6: kept for rotation, and specified for login in §6.3.
- Research: [credential surrogates](../research/credential-surrogates.md)

## Context

Several agent sandboxes shipped in 2025 and 2026 converge on one idea: the
agent holds a stand-in, and a trusted component swaps in the real credential
after the request has left the agent's control.

- Meta's Muse: `hatch-authd` mints surrogate tokens and Sentinel swaps them at
  the network boundary.
- Anthropic's sandbox-runtime: a per-session sentinel is swapped only on egress
  to `injectHosts`, behind a TLS-terminating proxy.
- Vercel and E2B: credential brokering at their egress gateways.
- Infisical Agent Vault.

The idea is older than agents. Horcrux (Li & Evans, 2017) autofilled dummy
credentials, then rewrote the POST before it was encrypted. It works because
page JavaScript can read what a password manager puts in the DOM.

The shared claim is strong: prompt-injecting the agent into revealing its
credential is futile, because it has none.

OpenSesame has most of the pieces already:

- **The domain model.** `CredentialDeliveryMode::Placeholder`, `PlaceholderPlacement` and `LegacyProjection` live in `crates/domain/src/authority.rs`. ADR 0006 adopted them. The 2026-08-08 audit bound substitution to the issued placeholder.
- **The upstream half of a broker.** `crates/invoke-through`:
  - owns `Authorization`, and callers may not set it;
  - allows only exact-host egress;
  - never follows a redirect;
  - holds the token only in memory and zeroizes it.

The last hop is missing. `opensesame dev run --agent` gives a child process an
`ostest_<uuid>` placeholder, then drops the projection. Nothing on the wire ever
redeems it. `connector-host::substitute_placeholder` computes the swapped value
and throws it away (`let _wired = …`).

The practical consequence falls on a static API key used by an unmodified SDK
for a provider with no native mint path (ADR 0049's `422 UNMINTABLE`). Today
there are only two ways to use it:

- IMPORT: the plaintext sits in a file the agent can read;
- a human `pass show --reveal` pasted into an environment variable.

Two earlier decisions stand in the way, and both were right about what they
rejected:

- **ADR 0005 §5** forbids a generic string replacer.
- **ADR 0076 §6** rejected a TLS-terminating swap for web-login rotation:
  - the untrusted page builds the request, so "the placeholder text itself [is]
    the authorization";
  - in-page hashing turns a placeholder into a new password that nobody holds.

This ADR adopts the pattern, but not the replacer.

## Decision

### 1. A surrogate is a presentation of a ConnectionRef, with the authority of L2

A surrogate is `osr_` followed by 128 bits of hex. It is issued for one
connection and one run. The owner can do exactly one thing with it: have
invoke-through make a call on that connection, to the hosts on that
connection's egress rule, in a shape the client chose.

That is ADR 0005's Level 2, constrained HTTP. It is gated as Level 2. The
issuer, not the ledger, refuses to mint a surrogate for a connection whose
`max_invoke_level` does not admit `ConstrainedHttp`. The ledger knows providers
and egress rules, not grants. It enforces one thing itself: it refuses a
provider with no egress rule, because a surrogate nothing could redeem is only a
placeholder.

A surrogate is never a SecretRef. It resolves to nothing, and the ledger that
knows it lives in the broker's memory. A restart revokes every surrogate, which
is the right failure.

### 2. Recognize, strip, re-place — never find-and-replace

The adapter does not rewrite the surrogate text into the credential wherever
the text appears. `SurrogateLedger::admit` (`crates/invoke-through/src/surrogate.rs`):

1. **Recognizes** the surrogate.
2. Checks it against the ledger.
3. **Strips** the header it arrived in.
4. Hands the request to `Invoker::execute`.

`Invoker::execute` then **re-places** the credential. It writes the credential
into the one site the provider's `EgressRule` names. That is the same code path
and the same sensitive header every brokered call already uses.

The text never becomes the credential. It only selects one.

This is what answers the 2026-08-08 audit's "the text itself [is] the
authorization". Admission requires all of:

- the ledger entry;
- the presenting caller;
- the destination;
- the declared site;
- the scope.

A surrogate found anywhere else is refused. The body, the query, a second
header and a header name all count as anywhere else. Refusal is correct because
the credential would never have been written there anyway.

This closes the reflection oracle that a find-and-replace proxy leaves open **by
construction, not by detection**. The attack is to put the surrogate in a gist
body, with a valid `Authorization` beside it, and read the gist back. That
cannot work here, because the credential is never written anywhere the client
chose.

### 3. The fences, in order, each its own refusal

1. At most one distinct surrogate per request (`Ambiguous`). One request can
   never carry two connections' authority.
2. Issued by this ledger (`Unknown`), not revoked (`Revoked`), not expired
   (`Expired`). A run's end calls `revoke_run`. Revoked entries are kept, so a
   late use trips `Revoked` rather than reading as noise.
3. Presented by the caller it was issued to (`ForeignCaller`). A surrogate
   copied out of a transcript, a log, or a model provider's retention is dead in
   any other process.
4. Sent over https to a host on its provider's rule, exact match, default port.
   Otherwise `Misdirected` (a lookalike or suffix host, another port) or
   `Cleartext`.
5. Scoped. The method must be one of the surrogate's `methods`. The path must
   fall under a `path_prefixes` entry on a segment boundary. A dot segment, raw
   or percent-encoded, is refused rather than resolved (`OutOfScope`). Both
   lists are required at issue time, and `/` is the explicit "anywhere".
6. Exactly one appearance, as the entire value of its declared site
   (`Misplaced`):
   - `Authorization: Bearer|token <s>`, or one named header;
   - no repeat of the header, no suffix, no second copy, no `Basic`.

**Format.** The marker is `osr_`, never a provider's own prefix, and a
surrogate carries no provider checksum. There are three reasons:

- Our own WebMCP fence and `observability` markers treat `ghp_…` as a live
  credential and would refuse it.
- A provider's secret scanning would treat a leaked surrogate as a leaked token.
- Most important: when a surrogate turns up somewhere, we must be able to tell
  "a surrogate leaked", which is benign and a tripwire, from "a credential
  leaked", which is critical.

A client that validates token format is served by `Handle` delivery or an L1
typed operation instead.

### 4. The credential never rides back in a response (landed as a fix)

The same oracle runs the other way. An upstream that echoes what it was sent
hands the caller the credential the broker placed. Examples:

- a debug route;
- an error quoting the rejected token.

This was open before surrogates existed. `Invoker::execute` returned the
upstream body verbatim. A red test in `invoke_tests.rs` demonstrated it:
`a_reflected_credential_never_reaches_the_caller` failed on `main`.

Every response now passes through `scrub::Needles`. Before the caller sees the
body or any allowlisted header, the following are replaced with
`[redacted:credential]`:

- the raw token;
- its percent-encoding;
- its base64 body, in both alphabets, at all three byte alignments. Alignment 2
  covers `Basic base64(user:token)`.

`ReceiptMeta.credential_reflected` records that it happened. A well-behaved API
never sets it.

This protects every invoke-through caller, not only surrogate clients.

Limits, stated plainly:

- A hash, an encryption or any other transform of the credential is not the
  credential, and is not matched.
- The scrub cannot be used as an oracle. Confirming a guess requires guessing
  the whole token.

### 5. Every refusal is a tripwire, and the client learns nothing from it

A surrogate outside its site has only one explanation: something copied it.
This matters most for one sent to a host that is not its own. That is the
signature of the exfiltration that surrogates exist to defeat.

Each `RefusalCode` has a stable `surrogate.*` name. The adapter converts it into
a `SecurityNotice` on ADR 0080's feed. It carries the run, the provider and the
fence, never the surrogate.

The client gets `Refusal::CLIENT_MESSAGE` whatever the code. A prompt-injected
process probing with guesses cannot learn which were real.

This is the honeytoken property that the surveyed designs leave unused. The
thing the agent holds is worthless to steal, and it also reports its own theft.

### 6. Per harness

#### 6.1 Native daemon and CLI — adopt

The adapter is a per-run proxy listener in the daemon, in front of
invoke-through. `opensesame dev run --agent` registers its projections there
instead of dropping them.

The daemon's budget (ADR 0048 §5) already admits hyper, hyper-rustls and
rustls. Certificate minting is the one addition, and it needs an ADR 0048
amendment when it lands.

The adapter must do all of the following:

- **Trust.** Mint an ephemeral CA per run. Hold its key in memory only. Hand it
  to the child alone, through the child's own trust variables:
  - `SSL_CERT_FILE`, `NODE_EXTRA_CA_CERTS`, `REQUESTS_CA_BUNDLE`,
    `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`.

  Never touch a system or user trust store. Upstream trust stays invoke-through's
  webpki roots.
- **Caller identity.** Attest it per run: a dedicated listener, a UDS peer
  credential, or a per-run proxy credential. Compare it exactly.
- **Request parsing.** Parse the request, then check it:
  - Refuse a request whose CONNECT authority, `Host` and TLS server name
    disagree.
  - Cap the body at the fence's 256 KiB before `admit`.
- **Headers.** Forward only the headers the provider's allowlist admits.
- **Un-surrogated traffic.** Default refuse, per the run's egress policy.
  `HTTPS_PROXY` is advisory. A process that bypasses the proxy holds only a
  dead string, so confidentiality survives a bypass. Detection does not, and
  network confinement is the sandbox's job.
- **Unmodifiable clients.** A certificate-pinning client fails closed. It never
  receives a fallback credential.

**Who gets one.**

- Providers with a native mint path keep ADR 0049's helpers. Git over HTTPS
  goes through `git-credential-opensesame`, not surrogates.
- Surrogates are for the `UNMINTABLE` case, where the only alternative today is
  IMPORT.

#### 6.2 Sandboxed agent runs — adopt

The same adapter serves sandboxed runs (the worker, and ADR 0081/0082 runs). The
run lease owns the ledger entries:

- parking or ending a run calls `revoke_run`;
- observation frames and transcripts contain surrogates only.

A `surrogate.misdirected` during a watched run is a reason to park the run, not
just a line in the log.

#### 6.3 Agent-driven browser — rotation: no, unchanged; login: specified, deferred

**Rotation.** ADR 0076 §6 stands for setting a password. If a page hashes the
field client-side, it silently turns a surrogate into an unrecoverable new
password.

**Login.** The trade is different, and the rubber-duck pass changed the answer.

What CDP `fill_credential` does and does not protect:

- It keeps the value from the model.
- It does not keep it from page JavaScript. A compromised third-party script on
  a login page reads the filled field, and a password outlives a session. That
  is exactly Horcrux's threat.
- Client-side hashing of a surrogate makes a login fail **loudly**, not
  silently.

A form login needs the credential in the body, so here the adapter must write
into a body field. The rules for when ADR 0076 §8's runner implements it:

- **Where it may substitute.** Only:
  - into one declared field;
  - of an `application/x-www-form-urlencoded` or JSON POST;
  - with identity content encoding;
  - to the exact action origin and path the recipe declares.
- **Everything else is `Misplaced`.** That includes any other appearance, a
  second field, or multipart.
- **Responses** are scrubbed as in §4.
- **Failure.** A failed login falls back to the recipe's CDP fill, never to
  retrying substitution.
- **Password-set fields** are never a substitution site.

Until then, the agent browser uses CDP fill.

#### 6.4 Browser extension — no substitution; fill by reference when autofill lands

Horcrux's rewrite is not available to a modern extension:

- Manifest V3 `declarativeNetRequest` can modify headers but never a request
  body.
- `webRequest`'s `requestBody` is read-only in every browser.

The only way to get it back is to run the person's everyday browser through the
daemon as a TLS-terminating proxy. That means a MITM CA, trusted for every HTTPS
session of their life, with its key on a disk. **Rejected outright.**

The extension has no autofill today (`apps/browser-extension`). When autofill
lands, it follows these rules:

- **Passkeys first.** The secret never exists.
- **Fill by reference.** Use `rotation-web`'s `FillCredential { reference,
  selector }` contract. The content script receives a value only at fill time,
  and only when all of these hold:
  - the top frame, with an exact-origin match;
  - a visible, focused field;
  - after a trusted gesture on extension-owned UI outside the page: the popup,
    the side panel, or a keyboard command.
- **Never** fill:
  - from an overlay injected into the page DOM. DOM-based extension
    clickjacking (Tóth, DEF CON 33, 2025) took eleven password managers through
    exactly that surface;
  - on load;
  - into a cross-origin frame.

**Residual, stated:** page JavaScript can read a value after it is filled. An
extension cannot close that. Passkeys can.

#### 6.5 Pages PWA — no substitution

A same-origin service worker is not a boundary against same-origin script. The
unlocked vault key lives in the page. Moving one token into the worker would
move nothing out of reach of a script that could already read the vault.

What Pages contributes already holds:

- WebMCP tools return metadata and `connectionRef`, never values (`vault-tools.ts`).
- The WebMCP fence's credential markers are one reason surrogates carry no
  provider prefix (§3).

#### 6.6 MCP servers — unchanged

`mcp-host` and `mcp-client` keep ConnectionRef plus a frozen Intent. Surrogates
are for tools that cannot speak that contract, not a second one.

The adapter's CLI verb will need a `capability-registry` entry (ADR 0065),
excluded from MCP and WebMCP, citing this ADR: it spawns processes.

#### 6.7 Gateway L2 placeholder simulation — retire into this path

`connector-host::invoke_l2_placeholder` checks placement, then discards the
swapped value. When the adapter lands, the L2 placeholder route admits through
`SurrogateLedger` and executes through `Invoker`. The simulation is then
deleted rather than kept as a second, divergent rule set.

### 7. An optional plugin, installed at runtime, off until switched on

Most people will never broker a credential for an agent. The proxy's
certificate minting, TLS termination and form rewriting are weight they should
not carry, and an agent-facing credential path they did not ask for is
surface they should not have.

So everything in §6 that runs is an **optional plugin**. It is never part of a
default build, a default binary or a default bundle. The core stays in the
default build: the §2–§5 ledger, the §4 scrub and the §6.7 correctness fix.
They are small, and every invoke-through caller needs the scrub.

**One definition.** `spec/plugins/catalog.json` (ADR 0139) names each plugin:

- `surrogate-proxy`, a native binary;
- `browser-autofill`, a companion browser extension.

For each plugin the catalog records its kind, the Settings capability that
owns its switch, and the daemon routes that answer only while it is on.
`crates/plugin-settings` reads it for the CLI and the daemon.
`packages/app-core` and `packages/capability-registry` read it through
drift tests.

**One switch, in one file.** Whether a plugin is installed, pinned and on
lives in one settings file, `plugins.json` in the config directory. Two
things write it:

- `opensesame plugins enable|disable`;
- the plugin's switch in Settings › Capabilities, through the daemon's
  `PUT /v1/plugins/{id}`.

Settings is that file (ADR 0134). Four rules hold everywhere:

1. **Off unless recorded on.** Every catalog row has
   `default_enabled: false`. Installing records a plugin **off**, and so does
   reinstalling or upgrading.
2. **The environment can only turn a plugin off.**
   `OPENSESAME_PLUGIN_<ID>=off` wins over the file. No value turns a plugin
   on: an operator can disable one for a process, and no environment can
   enable what a person did not.
3. **Pinned at install, verified at every launch.** Installing takes a
   `--sha256` and refuses a mismatch. Every launch recomputes the hash, and a
   binary changed since install is refused, never warned about.
4. **Installed from a terminal, never over HTTP.** A web page, a daemon route
   or a model cannot install one. Settings can switch an installed plugin on
   or off and show its state, nothing more.

**Where each piece lives.**

| Piece | Delivered as | Not in |
|---|---|---|
| Proxy (§6.1, §6.2) | `opensesame-surrogate-proxy`, a separate binary from `crates/surrogate-proxy`, installed with `opensesame plugins install surrogate-proxy --from … --sha256 …` | the `opensesame` binary or the daemon. A gate fails the build if either one's normal dependency tree reaches `opensesame-surrogate-proxy` or `rcgen`. This is ADR 0053's shape: the daemon gains zero dependencies. |
| Login-form substitution (§6.3) | the `login-surrogate` cargo feature of `rotation-web`, default off, used only while the `surrogate-proxy` plugin is on | a default build |
| Autofill (§6.4) | `@opensesame/browser-extension-autofill`, a companion extension with no static content scripts and only optional host permissions, granted per origin when the person turns it on | `apps/browser-extension`, whose bundle and manifest are unchanged. `/v1/fill` answers 404 unless `browser-autofill` is on. |
| Settings | two optional capabilities, `agents.surrogate-credentials` and `vault.browser-autofill`, loaded only after consent (ADR 0130) | the Pages bootstrap. The `minimal-local` profile proves their absence. |

When a plugin is absent or off, nothing changes. `opensesame dev run --agent`
behaves exactly as it did before this ADR, and it says once that surrogate
delivery is available as a plugin. It never materializes a credential to make
up for the missing plugin. When the plugin is installed and on but its pin no
longer matches, the run fails closed: a person asked for surrogates and must
not silently get something else.

### 8. What this does not do

- **Misuse inside scope.** A surrogate is the connection's authority on its host.
  Theft is closed; misuse is bounded only by §3.5's scope, the grant, and
  ADR 0048's per-invoke confirmation. The narrowest scope that works is the
  issuer's job.
- **An upstream that stores the presented credential.** Some upstream might put
  the presented credential somewhere the grant can later read. The scrub catches
  it only if it is read back through the broker.
- **Transformed surrogates are not detected.** A surrogate that has been
  uppercased, encoded or split can be smuggled anywhere. It is not detected, and
  it redeems nothing: only the exact issued text, in its exact site, is ever
  admitted (test `a_transformed_surrogate_is_inert`).
- **Same-user memory access.** An attacker who can read the daemon's memory as
  the same user is outside this boundary, as for every ADR 0048 broker.
- **Sessions.** ADR 0076 §7's session residual is untouched.

## Verification

**Landed with this ADR.** `cargo +1.88.0 test -p opensesame-invoke-through`
passes 45 unit tests. Clippy passes at the gate's pedantic settings. The quality
gate is clean, and `invoke.rs`'s ceiling was retired now that it is under 400
lines. `pnpm audit:daemon-deps` is clean: `base64` was already in the daemon's
tree.

- **Admission** (`surrogate_tests.rs`, `surrogate_lifecycle_tests.rs`). One test
  per attack:
  - misdirection, including lookalike and suffix hosts and a non-default port;
  - cleartext;
  - the gist reflection oracle;
  - query, path and percent-encoded placement;
  - another header, and a header name;
  - repeated and decorated sites;
  - two surrogates;
  - forgery;
  - a foreign caller;
  - expiry at the boundary;
  - revocation and its isolation;
  - transformed-and-inert;
  - method and path scope, including `..` and `%2e%2e`;
  - issue-time refusals;
  - a named-header site;
  - `Debug` redaction of a surrogate and of the ledger;
  - one client message.
- **Reflection** (`invoke_tests.rs`, `scrub.rs`):
  - raw, base64 at every alignment and in both alphabets, percent-encoded, and
    header reflection;
  - an untouched, byte-identical response when nothing is reflected.

  Both attacks were shown failing before the fix.

One bug was caught by the matrix itself: the ledger's derived `Debug` printed
every live surrogate. It was replaced with a counts-only `Debug`.

**Required of the adapter before it ships.**

- An end-to-end run against a TLS stub, proving each of these:
  - the child's traffic carries only the surrogate;
  - the stub sees the real bearer exactly once;
  - a reflected token comes back scrubbed.
- A `surrogate.misdirected` notice on the feed for a request to a second stub
  host.
- CONNECT, `Host` and SNI disagreement is refused.
- A pinned client fails closed.
- The CA never appears outside the child's environment.
- `revoke_run` runs on lease end.

## Alternatives considered

- **Find-and-replace on bound hosts** (Muse, sandbox-runtime, the glovebox
  gateway). Simpler to reason about for header-only use. Rejected because it
  leaves the gist oracle open unless placement is enforced anyway. Once
  placement is enforced, recognizing and re-placing costs nothing more and
  removes the rewrite.
- **Sealed secret in a header** (Fly.io Tokenizer, `Proxy-Tokenizer`).
  Stateless and elegant, but the client must be modified to send it. Modified
  clients already have `Handle` delivery. It also gives up per-run revocation
  and caller binding, which are what make the tripwire meaningful.
- **Placeholders in URLs** (Agent Vault's `__NAME__` in path or query).
  Rejected: URLs are logged everywhere, and ADR 0048's receipts already refuse
  to record a query.
- **Format-preserving surrogates.** Rejected in §3.
- **The daemon as the everyday browser's MITM** (Horcrux on today's web).
  Rejected in §6.4.

## Consequences

- There is now a path for unmintable static credentials that does not end in
  IMPORT. The adapter (§6.1) is the next slice. Its acceptance tests are listed
  above.
- Every invoke-through caller now gets scrubbed responses and a
  `credential_reflected` receipt flag.
- `surrogate.*` joins ADR 0080's vocabulary when the adapter wires the notices.
- ADR 0006's non-goal and ADR 0076 §6 are amended as described above, and each
  now points here.
