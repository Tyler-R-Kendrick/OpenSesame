# Audit — organization and OAuth client quotas (2026-08-08)

Tick 57. Scope: the newer control-plane routes —
`apps/control-plane/src/routes/oauth-clients.ts`, `organizations.ts`,
`audit.ts` — and the quota path they run through (`state.ts`,
`packages/policy`).

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | Organization and OAuth client creation were gated on assurance alone. Both write into an unbounded in-memory map, so one verified principal could register organizations and clients until the process ran out of room — while every other map in the system (sessions, device codes, frozen intents) has a fence and projects and agents have quotas. The policy module already says out loud that assurance "does not say they may mint resources forever". | `organization.create` and `oauth.client.register` now spend quota slots (`maxOrganizations`, `maxOAuthClients`), counted live from the stores and checked in both create routes. |
| Low | A provisional principal had no organization or client allowance expressed anywhere — the routes refused them, but the policy had nothing to say. | Both provisional limits are explicitly zero, so the PDP answers rather than relying on the route. |

## Not findings

- `GET /v1/audit/events` scopes on the caller's principal id, and both the memory
  and Postgres repositories honour that filter. Event metadata carries actions,
  states and ids — no codes, tokens or digests of them.
- Redirect URIs are already validated against `javascript:`/`data:`/`file:`,
  fragments and embedded credentials, on create *and* patch.
- Client and organization reads are owner-scoped, and unknown versus foreign ids
  answer the same 404.

## Notes

- Counting is live, not cumulative: revoking a client frees its slot, matching how
  projects and agents were fixed in an earlier tick. A cumulative counter would
  make the quota a lifetime cap.
- `POST /:id/rotate` mints a new client record and revokes the old one in the same
  breath, so it does not spend a net slot and is left unfenced by quota.
- Suspended organizations and clients still occupy a slot: a suspension is not a
  way to free capacity while keeping the registration.

## Gates

`pnpm test`, `pnpm run typecheck`, `cargo test --workspace`, `cargo clippy
--workspace --all-targets -- -D warnings`, task-security-battle-test, semgrep,
ast-grep, osv-scanner, gitleaks, cve-lite, cargo-audit — all clean.
