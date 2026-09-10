# ADR 0101 — Access operates the existing authority primitives

Status: Accepted
Date: 2026-09-09

## Context

Access rendered management controls, but authenticated browser grants did not
admit delegation, relay-decision or task routes. Requests omitted the Identity
authorization inbox. Missing service setup sent people to another screen.

## Decision

Keep Identity and Host separate. Access composes their existing primitives:

- Identity authorization requests record consent to a reviewed digest. Creation,
  review, comparison and transaction-bound passkey activation use the existing
  contracts and policy verifier. Consent is not a Host delegation.
- Host delegations remain claimable, time-bounded offers. Access and Identity
  share one claim ceremony; no credential materialization is added.
- Host task sessions use the existing immutable ceiling and version-checked
  termination. Creation derives principal and organization from Host claims,
  rather than editable form fields. A ceiling does not grant resource access.
- Connection policy and bindings remain the policy model. There is no second
  client-side policy database or cosmetic standalone policy object.
- Host endpoint configuration, browser pairing and Identity verification remain
  explicit ceremonies available inside Access. Identity setup is also inline.

The authenticated-browser route ceiling names exact route/method pairs. It is
added only after the existing verified Identity handoff and native membership
check, never to local-read pairing alone. Existing handlers still enforce
principal, organization, ownership, attenuation, digest and version checks.
Invoke, materialization, native administration and browser-control routes are
not admitted by this extension.

## Consequences

The shared-origin demo remains unable to use local authority. An offline vault
does not pretend to have a hosted approval service, but all sections remain
reachable and service configuration is not a front-door prerequisite.

An approval re-resolves current requirements. Passkey decisions run in a hosted
Identity-origin ceremony using its same-origin session cookie; Pages cannot use
another origin's passkeys. The popup URL contains only the request ID, reviewed
digest and decision, never a credential or comparison code. The hosted page
re-reads the request and policy, displays server-derived details, requires an
explicit confirmation and spends the existing transaction-bound activation.
Pages accepts only the authenticated API's resulting state, not popup messages.
Closing a review aborts polling and closes the ceremony; cancellation cannot undo
a decision already accepted by the server. Comparison values and claim tokens
are held only for the active ceremony, never written to browser storage.

WebMCP may navigate to the portal, but does not impersonate human approval or
run its authenticator ceremony. Programmatic task creation remains available
through the existing scoped MCP Host capability.

This is an operations portal over OpenSesame primitives, not a claim of complete
Tailscale PAM feature parity. Task sessions are not SSH/database terminals, and
their existing in-memory store does not become durable through this UI.

## Regression evidence

`browser_pam_tests.rs` exercises the full router with real DPoP proofs: local
pairing alone is refused; verified membership permits a bounded task; another
principal or organization is refused; termination and client revocation apply.
The route-map tests reject aliases and privileged routes. Pages tests exercise
creation, digest-bound approve/deny, cancelled activation, comparison codes,
scope validation and the shared claim ceremony. The Identity browser suite opens
the ceremony from a different origin, enrolls a real virtual authenticator and
verifies approve/deny through the cryptographic verifier with development
assertion shortcuts disabled. Wrong digests and cancelled authenticators leave
the request pending.
