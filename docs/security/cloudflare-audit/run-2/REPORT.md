# OpenSesame security audit, run 2

## Run

- Profile: standard, scoped to the run-1 findings, their fixes, and the S3 secret store added on main after run 1.
- Source: `6395f1e401d2acab18720e654fe9549d198a372b` (`cursor/cf-audit-getrun`), rebased onto `origin/main` `6a1648ed`.
- Prior run: `~/security-audit-skill/OpenSesame/run-1` at `a8843c3e`.
- Execution: source re-read of the fixes. Regression tests for those fixes were run while landing the stack (app-core, control-plane, api-client, browser-extension, authenticator-core, daemon proxy, relay body tests). The six needs_validation leads were not executed: this host still has no Android emulator, no Wine or cmd.exe, no Docker, no nats-server, and the audit sandbox file-size limit cannot compile wasmtime or the gateway.
- Worktree at review: clean.

## Posture

Run 1 confirmed eight findings. Each of those code paths is closed on this commit, so this run rejects those claims. It confirms nothing new. Six leads stay needs_validation with the same blockers. Two run-1 rejections are carried. The new device-local S3 store was reviewed at source: paths use one grammar that refuses dot segments and percent-encoding, cleartext is only allowed to loopback, redirects are errors, and the endpoint is the device owner's saved connector field.

This is not a claim that every run-1 covered unit was hunted again.

## Confirmed findings

None.

## Verdict counts

| Verdict | Count | Severity |
| --- | ---: | --- |
| confirmed | 0 | none |
| needs_validation | 6 | no severity |
| rejected | 10 | no severity |

The eight rejections that close run-1 confirmed findings were, at run 1: four high (federation token endpoint, tenant-join retarget, SCIM directory issuer, LD_AUDIT), one medium (IPv4-mapped request URI), and three low (relay body, daemon backslash, getRun origin). They have no severity in this run because they are rejected.

## Closed run-1 findings

- `app-core.federation.storage-selected-token-endpoint` — Shared-origin storage chooses the federation token endpoint and an unsigned ID token is saved
- `apps/pages/server/manage.mjs/readRawBody/unbounded-buffer` — Relay body readers retain the full request before authentication
- `apps/pages/server/webhook-queue.mjs/writeFileQueue/symlink-follow` — Default /tmp webhook queue symlink follow does not cross users
- `control-plane.org-join.email-retarget-membership` — Tenant join grants organization membership to the caller after verified-email auto-link binds the identity to another principal
- `control-plane.scim.principalsForSubject.omits-directory-issuer` — SCIM deprovision does not revoke members who signed in through the organization LDAP directory
- `crates/authenticator-core/host_is_private/ipv4-mapped-request-uri` — Invocation policy admits IPv4-mapped loopback and private request URIs
- `crates/breach-intel/src/event.rs/BreachEvent.occurrences/subscriber-count-oracle` — Publishing a breach occurrence count is the documented event boundary
- `daemon.proxy.backslash-canonicalizes-local-session` — Daemon loopback proxy canonicalizes backslash paths into the blocked local session mint
- `packages/cli/startup-env-denylist-omits-ld-audit` — Shared startup denylist omits LD_AUDIT, so an env template loads an audit object in the credential-bearing child
- `runner.drive.getRun-origin-unbound` — In-flight runner keeps filling an origin after its arm expires when getRun names another armed origin

## Needs validation

- `apps/android/invocation/custom-scheme-skips-validate-platform-invocation` — Exported custom-scheme handlers skip invocation policy before wallet operations
- `crates/sandbox/spawn/grant-expiry-not-rechecked` — Sandbox broker calls ignore grant expiry after the profile is minted
- `domain.EgressBinding.allows_url/encoded-path-escape` — Path-scoped egress allowlist accepts encoded traversals that decode outside the prefix
- `gateway/observation-control/role-evidence-fence-skipped` — Role evidence fence does not bind observation control or one-shot log reads
- `opensesame.cli.connect.open_url.authorization-url-cmd-start` — Windows open_url passes a Host authorization_url to cmd.exe /C start
- `ops/compose/docker-compose.yml/nats/plaintext-host-port` — Compose publishes the NATS client port with no host IP and no server auth config

## Coverage

46 ledger units. 45 carried from run 1. One new unit for `packages/app-core/src/lib/secret-fs/s3.ts`, covered, no finding. Units whose only run-1 confirmed fingerprint is fixed are covered. The authenticator unit stays a candidate because the custom-scheme handoff is still needs_validation. Deferred units from run 1 stay deferred. Unchanged covered units were not re-hunted.
