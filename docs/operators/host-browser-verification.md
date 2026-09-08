# Browser identity and one-use control verification

Pairing grants encrypted sync, not operator authority or permission to control
an agent-driven browser. After pairing, **Verify browser identity** opens the
configured Identity origin. Browser-control buttons use the same ceremony,
followed by a separate approval bound to the exact run and transition.

## Deployment requirements

- Use a loopback development or dedicated-origin Pages deployment. The shared
  GitHub Pages demo cannot pair with local authority.
- Configure Identity's exact HTTPS public URL and issuer. For local development,
  use `http://localhost:8788`, not an IP-literal RP ID: Chromium rejects WebAuthn
  RP IDs such as `127.0.0.1`. Enabling Host authorization with an IP-literal
  Identity public URL fails startup with this diagnostic.
- Add the exact Pages origin to Identity's explicitly configured CORS origins.
  This allowlist also admits the popup ceremony; no foreign origin is added
  automatically. URL paths do not create separate origins.
- Set `OPENSESAME_HOST_AUTHORIZATION_AUDIENCES` to the exact Host resource
  audience and configure persistent `OPENSESAME_JWKS_JSON` containing the
  approved RS256 signing key. Configure the Host verifier with that exact
  Identity issuer, resource audience and public verification keys. Do not
  copy a private key to the Host, browser, repository or model input.
- Approve the browser pairing for the canonical principal and organization
  represented by the person's Identity membership. A local-only identity is
  not automatically joined or promoted to an Identity principal.
- The Identity origin must have its own authenticated session and enrolled
  passkey. An adopted bearer held only by Pages is not forwarded through the
  popup. A missing Identity session is a refusal, never an unverified success.

## Ceremony

The Identity window displays the Host audience, requesting origin, operation,
transition, target, organization and expiry. The person explicitly presses
**Verify with passkey**. The actual Identity verifier requires user presence,
user verification, the expected RP ID/origin, a valid signature, and the frozen
transaction challenge. It consumes that challenge and rechecks membership.

The signed assertion returns through an exact-origin, exact-window, fresh-state
message exchange. It never appears in a query, fragment, storage, console or UI.
Pages submits it to the paired Host using DPoP. The Host decides whether to
authenticate that browser or return a one-use control elevation. The protected
control request includes that elevation; ordinary sessions do not substitute.

Cancel, lock, unmount, a changed run, expiry or a closed popup cancels the client
transaction. A late result cannot revive a cleared pairing. Once a request has
already reached the server, cancellation cannot undo a completed server action;
the server's atomic consumption and revocation remain authoritative.

Public daemon health reports only `status: ok`. Obtain Serve addresses from the
local launcher or authenticated operator status, not unauthenticated health.
Endpoint claims inserted into public health are ignored.

## Security limits

DPoP prevents replay by a holder without the paired key, not malicious JavaScript
already running in the paired origin. The Identity-origin passkey ceremony is
therefore a separate high-authority verification step. A compromised Identity
origin or approved signing authority remains a trust-domain compromise. Browser
popup restrictions, an unavailable passkey, or a missing Identity session cause
an explicit refusal; they do not enable a weaker fallback.
