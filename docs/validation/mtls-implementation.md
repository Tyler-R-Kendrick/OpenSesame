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
| Baseline before this work | `424bc48cfb74e3c69f4f1f6b44cbe5b2fb979716` (the directive inspected `f1c1e7ae`, one Pages-only commit earlier; that delta touches no transport seam) |
| Branch | `claude/new-session-j3usv4`, pull request #453 |
| Size of the change | 631 files, about 76 000 insertions |
| Toolchain | rustc/cargo 1.88.0, Node 22.22.2, pnpm 9.15.0 |
| Relevant resolved libraries | rustls 0.23.43 (ring provider), tokio-rustls 0.26.4, rustls-webpki 0.103.13, async-nats 0.50.0, nkeys 0.4.5, spiffe 0.16.1, sfv 0.15.0, oidc-provider 9.11.2, structured-headers 2.1.0 |
| Pinned disposable servers | nats-server 2.11.17, OpenBao 2.3.2, SPIRE 1.12.6, Caddy 2.11.4 — all fetched and sha256-verified by `scripts/mtls-fixtures.sh` |

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
base build**, proven by running each against a build of `origin/main`. They are
pre-existing and not caused by this work.

## 3. Capability status, stated exactly

| Capability | Status |
|---|---|
| Native TLS listeners and clients, private PKI | implemented, executed, passed |
| SPIFFE X.509-SVID consumption through the Workload API | implemented, executed, passed against real SPIRE 1.12.6 |
| RFC 9440 originating-client evidence behind an authenticated ingress | implemented, executed, passed against real Caddy 2.11.4 |
| RFC 8705 client authentication and certificate-bound access tokens | implemented, executed, passed (first-party provider) |
| NATS client mTLS, certificate mapping, TLS-first, route cluster | implemented, executed, passed against real nats-server 2.11.17 |
| Native NATS authorization callout with independent Host verification | implemented, executed, passed in configuration mode only |
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
| The four libFuzzer entry points | require a nightly toolchain and a sanitizer build of a separate workspace; the container had under 4 GiB free. Each target's body is mirrored by a property test that does run, so only the fuzzing harness is unproven |
| NATS operator mode | not exercised; its issuer, audience and account rules differ from configuration mode and no claim is made about it |
| The callout xkey envelope | unit-tested, not live-tested; the live server was not configured with it |
| Real certificate provisioning in a browser | the browser fixture proves harness-provisioned TLS only, and says nothing about how a person obtains or selects a certificate |
| `pnpm verify` and the whole-repository clippy gate | both fail on pre-existing debt unrelated to this work |

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
