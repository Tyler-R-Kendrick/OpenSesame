# Host browser authorization ceremony and lifecycle review

## Scope

Pages pairing lifetime, Identity-origin WebAuthn popup, transaction-bound Host
assertion relay, first-party run-control calls, and daemon health consumption.
This is source review plus deterministic unit and real-browser evidence, not a
Codex Security, DeepSec AI, or Mantis scan.

## Corrections implemented

- Key generation, proof creation, polling and authenticated requests are tied
  to the tab's pairing lifetime. Cleanup aborts pending requests and late work
  cannot store or restore credentials. React remounts bind the ceremony to the
  exact run/operation; stale UI callbacks cannot complete a replacement request.
- WebAuthn executes on the Identity origin, not a third-party Pages origin.
  The popup requires an explicitly admitted Pages origin, fresh 256-bit state,
  exact opener/source checks, a bounded lifetime and a single result. Its CSP
  denies framing and permits only same-origin script/style/API requests.
- Real Identity session and user-verified passkey evidence produce the signed
  frozen Host tuple. Pages forwards that assertion only to the paired Host.
  Run-control calls require the resulting one-use elevation; no token-bearing
  URL, browser operator credential, silent assurance promotion or fake verifier
  was introduced.
- The real Chromium oracle found that an IP-literal Identity RP ID is rejected
  before WebAuthn. Host authorization now refuses that configuration at startup
  and documents `localhost` for local Identity. Host resource audiences remain
  independent and may use their explicitly configured loopback endpoint.
- Public health is treated solely as liveness. Advertised service/Host/Identity/
  Serve metadata is ignored. Optional authority JSON responses are stream- and
  time-bounded and errors do not include provider response text.

## Evidence

`apps/control-plane/scripts/verify-host-authorization.mjs` uses real Chromium,
the actual Identity Hono application, generated fixture RSA/P256 keys, an
authenticated fixture cookie, and a virtual user-verifying authenticator.
Every network request is intercepted or refused. The test proves no assertion
is returned before the human button, verifies the displayed target, completes
real SimpleWebAuthn verification, and independently verifies the returned RS256
JWT's type, audience, issuer, transaction digest, transition and assurance.

Successful command (installed browser override, no downloads):

```sh
PLAYWRIGHT_CHROMIUM=/home/codex/.cache/ms-playwright/chromium-1223/chrome-linux/chrome \
  pnpm --filter @opensesame/control-plane exec tsx scripts/verify-host-authorization.mjs
```

Regression files cover wrong popup/source/origin/state, duplicate result,
swapped target, closed popup, lock/cancel/remount races, generated proof races,
oversized/stalled/invalid endpoint bodies, exact Identity origin admission,
and real passkey verification including missing UV and concurrent consumption.
The focused command results and final integrated gates are recorded in the PR;
this record does not claim a repository-wide clean result from focused tests.

## Residuals

Same-origin malicious JavaScript can use a non-extractable paired key. Identity
origin compromise or signing-key compromise remains outside the protection of
an assertion signed by that authority. The popup requires a real authenticated
session on Identity; a bearer held only in Pages is not copied across windows.
Cancellation cannot roll back a server action already committed. Host atomic
consumption, session revocation and run-version checks remain required.
