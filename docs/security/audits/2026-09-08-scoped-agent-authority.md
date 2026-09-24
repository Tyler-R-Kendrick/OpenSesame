# Scoped local agent authority

The former MCP fallback from a native session to an operator environment token
crossed the human/agent boundary. The replacement requires an explicit native
operator decision for one client UUID, one MCP audience, one Host resource and a
closed task/ciphertext-sync operation ceiling. A 256-bit one-use launch handle
is exchanged for a five-minute capability. Only digests are stored.

The Host checks the durable grant and revocation state before every agent
request. A typed credential class prevents presenting the same bytes as an
ordinary native session. The daemon's current-user Unix socket attestation is
necessary for its local exchange adapter, but no longer substitutes for operator
authentication on its human administration routes.

The native launcher clears the child environment. Operator and human Identity
credentials are not forwarded. Unix acquisition uses an exact, owner-only socket;
the explicit Windows compatibility path exchanges the same single-use handle
against the configured Host. Neither path manufactures authority from same UID.
Transport failures, redirects, oversized responses and binding mismatches fail
closed. Launch material is never printed. Process-local redaction retains at
most 64 sensitive strings for at most five minutes, without a readback API.

MCP catalogs now expose only reviewed task lifecycle, ciphertext sync and
minimal liveness/discovery/identity operations. Human administration, raw claim
presentation and unreviewed metadata registrations were removed, not left as
advertised commands that always fail. Human CLI and browser capabilities remain
separate. ADR 0099 records the exclusions.

## Focused evidence

- Durable launch tests: three passing cases cover exact client/audience/resource
  binding, concurrent single-winner exchange, expiration, owner-scoped revocation,
  restart persistence and bounded expired-launch cleanup.
- Daemon tests: 113 passing cases, including same-UID requests without an operator
  credential being refused. Full-feature daemon Clippy passed.
- Shared Node acquisition and MCP boundary tests: 51 passing focused cases;
  owned Unix-socket and handler tests: 60 passing cases before catalog narrowing.
- Final narrowed MCP packages: 20 test files, 125 passing tests, with owned
  loopback servers enabled. Both MCP package TypeScript checks passed.
- Native CLI module: two passing unit tests for exact Host transport and the
  child environment allowlist; focused library Clippy passed. Legacy credential
  agent: four tests passed after removing startup demo sessions and requiring
  strict deployment configuration and an explicit operator credential.

This is focused implementation evidence, not an executed repository-wide AI
scan. The integrated Gateway route mount, credential-class matching, native CLI
dispatch and end-to-end revocation tests remain the integration steward's gates.

## Residual boundary

A same-user malicious process can steal a pending handle or a short-lived agent
bearer from process memory/environment. Client and audience fields prevent
accidental cross-client use; they are not hardware sender proof. The stolen
credential is still bounded to the approved principal, organization, Host,
operation ceiling and five-minute lifetime. It cannot acquire operator,
browser-control, secret-materialization, approval or unrestricted proxy rights.
The user-selected executable and arguments are part of the native operator's
explicit launch decision. A compromised OS or intentionally malicious operator
is not defeated by environment minimization.
