# ADR 0108: Explicit role policy for browser-local application scopes

Status: accepted

## Context

Application registration (ADR 0106) bounded the client and callback, but its
scope list admitted every member of the bound organization. That list is a
client ceiling, not a sufficient per-person authorization policy.

## Decision

Each registered scope has an explicit set of organization roles allowed to
consent to it. The existing owner/admin/member vocabulary is reused. There
is no implicit owner bypass or role hierarchy. An empty set denies everyone.
The registration editor uses native, labeled checkboxes and retains drafts
when persistence fails.

Access → Policies exposes the same registration editor used by Identity →
Applications. Both write the same encrypted configuration and evaluator; no
Host or Identity endpoint gates local policy administration. Directory read
failures disable stale edits without treating the policy set as empty, and
disabled application identities cannot gain new scope admission through this UI.

Version 1 registrations without this policy admit only `openid` to current
members. Other legacy scopes are denied until the custodian explicitly saves
their role policy. No read silently rewrites historical storage. Every new
save persists version 2 with the complete policy and increments the
registration revision. Older builds reject version 2 rather than ignoring
its policy. Version 2 without a complete policy is corrupt and refused.
Close older issuer tabs and reload before using the new policy; a tab already
holding decrypted vault authority is not controlled by a later JavaScript
deployment. Rollback requires retaining version 2 support, not removing the
policy or downgrading stored data.

The existing session/directory fence checks membership and scope policy at
admission, code redemption and every grant use. A policy change invalidates
pending codes and active grants through the registration revision. Changes
to membership already invalidate local sessions through directory revision.

The browser SDK's `check(scope)` asks the open issuer to validate a specific
consented scope against current policy. It checks the echoed scope before
returning identity. Applications must check at protected decision points;
an earlier successful check is not a perpetual grant.

## Boundaries

These are permissions for the registered application, not Host, connector or
vault authority. The application owns enforcement over its own resources;
the issuer does not run application code or release vault data. No additional
credential is stored in the relying party. This browser-mediated profile is
not a remotely reachable OIDC authorization server, and same-origin script
compromise remains inside the browser trust boundary.

## Proof

The local application policy and admission tests cover all three roles,
deny-by-default legacy scopes and malformed policies. Grant tests refuse
policy changes before protected effects. The registration browser contract
uses Tab/Space to enable a role and proves it persists without enabling the
other roles. The cross-origin IAM verifier exercises live scope checks.
