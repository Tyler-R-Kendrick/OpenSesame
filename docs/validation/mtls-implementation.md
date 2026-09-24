# Optional mTLS and workload identity — implementation evidence

Companion to [ADR 0132](../adr/0132-optional-mtls-and-workload-identity.md) and
[the operator guide](../operators/mtls.md). The threat model is
[`docs/security/mtls-threat-model.md`](../security/mtls-threat-model.md).

This document records what was **implemented**, what was **configured**, what
was **executed**, and what **passed** — as four different things. A row that
says `implemented` is not a claim that it ran. A row that says `passed` names
the command that produced it. Anything that could not run says why.

## 1. Tested tree

| Field | Value |
|---|---|
| Baseline the work was built on | `424bc48cfb74e3c69f4f1f6b44cbe5b2fb979716` (the directive inspected `f1c1e7ae`, one Pages-only commit earlier; that delta touches no transport seam) |
| Base at the time of this report | `8a47abd49b9bbd29eca5c8d0b06f1163fe18a233`, merged in after the duress profiles landed on `main`; that work claimed ADR numbers 0130 and 0131, so this decision record was renumbered to 0132 |
| Branch | `claude/new-session-j3usv4`, pull request #453 |
| Size of the change | 635 files, about 76 900 insertions, measured against the merged base |
| Toolchain | rustc/cargo 1.88.0, Node 22.22.2, pnpm 9.15.0 |
| Relevant resolved libraries | rustls 0.23.43 (ring provider), tokio-rustls 0.26.4, rustls-webpki 0.103.13, async-nats 0.50.0, nkeys 0.4.5, spiffe 0.16.1, sfv 0.15.0, oidc-provider 9.11.2, structured-headers 2.1.0 |
| Pinned disposable servers | nats-server 2.11.17, OpenBao 2.3.2, SPIRE 1.12.6, Caddy 2.11.4 — all fetched and sha256-verified by `scripts/mtls-fixtures.sh`; pinned for linux-amd64 and linux-arm64 (the arm64 set added 2026-09-23, cross-checked against the same upstream checksum files except OpenBao's, which publishes only a cosign signature) |

Every fixture binary is pinned by version and by hash of both the archive and
the extracted binary. One exception is recorded honestly: OpenBao publishes no
checksum file for its release, only a signature, so its hash is our own of a
single download rather than an upstream cross-check.

## 2. What the static application still does

The product requirement above every other was that the browser-local
application keeps working with none of this present. It does.

| Property | Evidence |
|---|---|
| An empty device with no endpoints configured completes guest, vault and settings journeys with no network setup prompt | `pnpm --filter @opensesame/pages verify:transport`, 63 checks, exit 0; fails on any loopback request |
| A remote target with broken TLS degrades only that target | same harness, the bad-remote journey: exactly one status request and one verify request leave the tab, only the observed row degrades |
| No native TLS, filesystem, workload-socket or process adapter reaches the shipped bundle | `scripts/mtls-static-imports.mjs`, 69 chunks scanned plus the transitive dependency graph, exit 0 |
| Touch, keyboard, local sign-in and self-issued identity journeys unchanged | `verify:mobile`, `verify:keyboard`, `verify:local-iam`, `verify:siop`, all exit 0 |
| A browser operation needing a vault-controlled TLS identity | returns a typed unsupported outcome; no key export, no silent proxy |

Two Pages gates, `verify:static` and `verify:auth`, fail — **identically on the
base build**, proven by building `apps/pages` from the merge base
`8a47abd` and running each gate against it. `verify:static` reports the same
ten failed checks on both builds, all of them about the setup tabs, the
footer strip and the statusline, and none of them transport. They are
pre-existing and not caused by this work.

## 3. Capability status, stated exactly

| Capability | Status |
|---|---|
| Native TLS listeners and clients, private PKI | implemented, executed, passed |
| SPIFFE X.509-SVID consumption through the Workload API | implemented, executed, passed against real SPIRE 1.12.6 |
| RFC 9440 originating-client evidence behind an authenticated ingress | implemented, executed, passed against real Caddy 2.11.4 |
| RFC 8705 client authentication and certificate-bound access tokens | implemented, executed, passed (first-party provider) |
| NATS client mTLS, certificate mapping, TLS-first, route cluster | implemented, executed, passed against real nats-server 2.11.17 |
| Native NATS authorization callout with independent Host verification | implemented, executed, passed in configuration mode only — bare and `xkey`-sealed envelopes, the sealed mode live-tested against the pinned server on 2026-09-23 (§8) |
| Upstream mTLS bound to a ConnectionRef, with OpenBao certificate auth | implemented, executed, passed against real OpenBao 2.3.2 |
| Managed-certificate custody, renewal, activation facts, revocation, trust administration | implemented, executed, passed |
| NATS operator mode, gateway, leafnode, websocket, replicated JetStream | **unsupported** — no listener shipped, no test, not advertised |
| Certificate enrollment servers (EST, ACME, SCEP) | **unsupported** — none exist in this repository; the standards matrix previously claimed an EST server at a path that does not exist, and that claim is corrected |
| A browser attaching a vault key to its own TLS handshake | **unsupported** by the platform, and reported as such rather than worked around |

## 4. Security properties, and their actual bounds

The revocation answer is deliberately not a single word. Each layer states what
it enforces:

| Layer | Bound |
|---|---|
| New handshakes | refused immediately in the process holding the denylist; other processes pick it up from the stored binding set on their next read |
| Established connections | refused on the connection's **next** guarded operation; a request already in flight completes, and the TLS session itself is not torn down |
| Issued tokens | **not** revoked by a transport revocation; OpenBao and OAuth tokens keep their own lifetime and their own revoke verb |
| Offline and cached state | out of reach entirely; no claim is made that revocation erases local data |
| NATS sessions | the only server-enforced bound is a callout-issued token's expiry, proven by observing the disconnect; static users have none, and that is reported rather than invented |

Authentication is never authorization anywhere in this work: a verified peer is
resolved to an explicit, default-deny service binding, and the effective
authority is the intersection of transport admission, that binding, the current
grant and the resource policy. A bridge or worker peer can never become an
operator caller, and a source-contract test pins that.

## 5. Independent review findings

An independent adversarial swarm reviewed the implementation swarms' work
rather than trusting it. It found and fixed three genuine defects, all in the
Identity plane's peer-evidence extraction:

1. Two workload identities were derived from a certificate carrying two SPIFFE
   names, where the Rust plane correctly derives none. A certificate issued for
   one service could have matched a binding for another.
2. Names were validated with locally written patterns instead of the shared
   decoder, so an address-shaped name became an accepted identity — against the
   rule that identities are never joined by email.
3. The verified-peer type had a reachable public constructor that skipped the
   validity-window check and accepted the thumbprint as an argument, so any
   importing module could mint evidence for a supplied certificate.

It also caught two stale claims of success: the ingress crate's tests did not
compile at the commit whose report claimed they passed, and the source-contract
gate protecting against forged evidence was itself failing. Both are fixed, and
the gate was made stricter rather than merely repaired.

A separate correction came from the callout work: the authorization-request
subject and audience fields in this project's own brief were wrong, verified
against the pinned server's behaviour. As specified, the bridge would have
rejected every genuine callout.

## 6. What did not run

| Item | Why |
|---|---|
| The four libFuzzer entry points | **closed 2026-09-23 (§8).** At this record they had not run: they require a nightly toolchain and a sanitizer build of a separate workspace, and the container had under 4 GiB free. Each target's body is mirrored by a property test that did run, so only the fuzzing harness was unproven |
| NATS operator mode | not exercised; its issuer, audience and account rules differ from configuration mode and no claim is made about it |
| The callout xkey envelope | **closed 2026-09-23 (§8).** At this record it was unit-tested but not live-tested; the live server had not been configured with it |
| Real certificate provisioning in a browser | the browser fixture proves harness-provisioned TLS only, and says nothing about how a person obtains or selects a certificate |
| `pnpm verify` and the whole-repository clippy gate | both stop on pre-existing debt, measured rather than assumed — see below |
| A Host secure-listener test in the gateway binary | none exists. The listener's real-handshake behaviour is covered by `opensesame-transport-security`'s own listener tests and by the interop crate's 21 scenarios, including the gateway process refusing to start rather than downgrade. The integration suite no longer implies a gateway test that was never written |

### Three steps that reported a result they had not earned

Running the suites on a clean runner rather than a developer machine exposed
three of this work's own reporting defects, all of which were overstating or
understating what ran. They are recorded here because the directive's whole
point is that `passed` and `not_executed` are different words.

**Every TypeScript step read as "nothing ran".** The manifest parses runner
output with patterns anchored against plain text, and CI looks like a terminal
to vitest, so its summary arrived wrapped in colour escapes and matched
nothing. Six suites that were passing were recorded as failed or not executed.
The escapes now come off before any pattern is applied. The regression test
uses the bytes from the failing run: the summary CI recorded as "nothing ran"
parses to 472 passed.

**Two live steps selected no tests at all and said so honestly, which is why
they failed.** The NATS live suites are gated on the `live-tests` feature, not
on `jetstream`, so with only `jetstream` the modules were never compiled; and
the gateway step filtered ignored tests on the word "transport", which the
gateway's one ignored test is not called. Both selectors are corrected, and
what had been two empty selections is now **eleven live tests that actually
run** — ten against the pinned nats-server, one for the gateway's operator
route. That the manifest called an empty selection a failure rather than a
pass is the design working.

**The browser step carried someone else's red gate.** It ran the repository's
`verify-static-origin.mjs`, which fails identically at the merge base and which
no CI job gates on today; making it blocking here would have imported unrelated
debt into the merge gate. It still runs and its real result is still published,
now as `failed_non_blocking` with the reason attached. `AT-STATIC-EMPTY` is
proven by the no-certificate scenario that loads the static app with no
certificate at all, which passes and does block.

With those three corrected, both suites pass on this tree: the fast suite 15
of 15, and the real-protocol suite 17 of 17 against the pinned nats-server,
OpenBao, SPIRE, Caddy and Chromium.

### The two Rust gates, measured

The claim that the Rust gates fail on debt this work did not create was
checked against a clean build of the merge base rather than taken on trust.

`cargo fmt --all --check` fails on **34 files at the merge base and 24 on this
branch**, and the 24 are a strict subset of the 34. This branch introduces no
formatting failure and brings ten files into compliance, all of them gateway
and connection-broker files its swarms had to touch anyway. The 24 that remain
are duress, `pass`, human-vault, sealed-store and daemon files the branch does
not touch.

The clippy gate stops before it reaches this work at all: a missing-backticks
lint in `crates/enforcement/src/platform.rs`, last changed by an unrelated
pull request, and four more under `crates/storage/src/authority`, none of
which this branch touches.

Scoped instead to the twelve crates this branch owns or changes, and run with
the gate's own deny set (`-D warnings -D clippy::pedantic` plus the four
complexity lints), clippy reports exactly two findings — and both predate the
branch:

| Finding | Why it is not this work's |
|---|---|
| `probe_access_token_account` trips `too_many_lines` at 125 | the same function was longer at the merge base; this branch's only change to that file deletes a stray blank line |
| `items_after_statements` in `tests/rotation_leftover.rs` | the file is not in this branch's diff at all |

Both are in the connection broker, and both are left alone: refactoring code
this work does not touch semantically would widen the change.

Three findings in that scope *were* this branch's, and all three are fixed —
an unnested or-pattern and a `match` that reads better as `let...else` in the
worker, and a `#[must_use]` on a function already returning a `#[must_use]`
type. Everything else in scope is clean: transport-security, spiffe-source,
ingress-evidence, nats-callout, domain, gateway, worker, invoke-through,
provider-openbao, task-bus and the interop crate.

## 7. Reproducing this

```bash
pnpm test:mtls                 # fast suites, no network
pnpm test:mtls:fixtures        # fetch and verify the pinned servers
pnpm test:mtls:integration     # real nats-server, OpenBao, SPIRE, Caddy
pnpm test:mtls:browser         # Playwright client-certificate fixtures
```

Sanitized machine-readable results are written under `artifacts/mtls/`, with
every credential, token, key and session secret redacted before a log is stored
or hashed.

## 8. The 2026-09-23 completion pass

Two rows of §6 were gaps in opportunity rather than design. Both are closed,
and everything below actually ran (the callout `xkey` live tests and the
linux-arm64 fixture pins being the only code changes in this pass).

| Previously not run | What ran | Result |
|---|---|---|
| The callout xkey envelope | The pinned nats-server 2.11.17 configured with `auth_callout.xkey`, and the in-process bridge holding the matching callout xkey, with every callout envelope recorded by a passive subscriber (`crates/nats-callout/tests/live_callout.rs`): `cargo +1.88.0 test -p opensesame-nats-callout --all-features -- --ignored` | **passed**, 7 of 7 live tests. The sealed path admits and denies exactly as the bare path does; the reply is an `xkv1` box back to the server's key; a real sealed envelope is refused (`xkey_required`, `xkey_open_failed`) under no, wrong, missing-header and lying-header xkey and reaches no Host; a sealing server never serves a bare bridge (no message is ever delivered, `authorization violation`, zero Host decisions); an xkey bridge still serves a bare server unsealed |
| The four libFuzzer entry points | `cargo +nightly fuzz run <target> -- -max_total_time=45` per target (cargo-fuzz 0.13.2 on the nightly toolchain — both present in this environment, and the earlier 4 GiB constraint gone) | **passed**, no crashes, leaks, timeouts or artifacts: `transport_bindings_config` 3 324 116 runs, `transport_callout_envelope` 903 904, `transport_ingress_fields` 1 167 621, `transport_leaf_parse` 1 315 326 |

The pinned fixtures gained a **linux-arm64** asset set, recorded and hashed
here and cross-checked the same way as amd64: both nats-server releases against
their upstream `SHA256SUMS`, SPIRE against
`spire-1.12.6-linux-arm64-musl_sha256sum.txt`, Caddy against the sha512 in
`caddy_2.11.4_checksums.txt` — all match. OpenBao again publishes only a cosign
`.sig`, so its arm64 hashes are our own of a single download. `uname -m`
selects the set; any other platform still exits 3.

On linux-arm64 the whole real-protocol suite ran twice (AT-EVIDENCE-REPEAT),
each with its own run directory. The first run was 15 of 17: one pre-existing
callout test hit its nats-server startup deadline while the machine was still
compiling other work (the deadline is now 30 s rather than 10 s), and the
browser step went red because `PLAYWRIGHT_CHROMIUM` named a path this machine
does not have — a missing browser is red, not skipped. With those two fixed the
second run is **17 of 17, 0 failed, 0 not_executed**: fixtures, SPIRE 1.12.6,
Caddy 2.11.4, task-bus 10, callout 7 (the sealed suite included), OpenBao cert
auth 3, the real `opensesame-gateway` process (1 + the interop crate's 21,
including refuse-to-start rather than downgrade), Identity real-TLS 55, and the
Chromium client-certificate journeys 10 (`AT-STATIC-EMPTY`,
`AT-BROWSER-EXTERNAL`, `AT-BROWSER-UX`, `AT-EVIDENCE-STALE`,
`AT-BROWSER-CACHE`, `AT-STATIC-BADREMOTE`). Notably the browser step's
static-origin journey — published as `failed_non_blocking` in §6's
"three steps" record against the earlier base — now passes every check on this
tree, the experience-journeys fixes having landed between the two records.

One behavioural finding worth carrying forward: `async-nats`'s `connect()`
resolves — and `flush()` can complete — before the server has registered the
session. A test asserting "this client was not admitted" must probe **message
delivery** (and observe the server's close), not the shape of one client-library
call; `a_sealing_server_never_serves_a_bridge_without_the_xkey` does exactly
that.

Still not run, unchanged from §6: NATS operator mode (unsupported and not
claimed), real certificate provisioning in a browser, `pnpm verify` and the
whole-repository clippy gate (pre-existing debt — the scoped clippy in this pass
stops at the same `doc_markdown` finding in `crates/enforcement` unless scoped
with `--no-deps`, where the gate's exact deny set reports `opensesame-nats-callout`
clean), and a Host secure-listener test inside the gateway binary (covered by
the interop crate's process tests).
