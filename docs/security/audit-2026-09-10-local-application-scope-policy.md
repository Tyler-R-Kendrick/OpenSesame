# Browser-local application scope policy

Date: 2026-09-10

## Finding and correction

Local application admission previously treated the client's registered scope
list as sufficient for every organization member. A client ceiling does not
encode which members may receive a particular permission.

Registration now stores a complete per-scope owner/admin/member policy. Empty
role sets deny all callers, including owners. Legacy records admit identity
only; a new custom scope requires an explicit role choice. Version 2 storage
prevents older readers from silently ignoring the policy.

The existing session fence, exact client/callback admission, PKCE code exchange
and grant checks remain the enforcement path. Policy changes advance the
application revision and invalidate pending codes and active grants before
protected callbacks execute. Registration inputs are copied before asynchronous
work so later caller mutation cannot change the validated policy.

The browser client checks the exact requested scope through the issuer's live
grant check. It refuses a scope outside the original consent, and validates
the scope returned with the identity response. No vault/Host operation or
credential is added to the channel.

## Evidence and limits

Focused application, policy, grant, issuer and editor tests passed (51 tests).
They exercise all three roles, legacy and malformed versioned records, policy
change invalidation and persisted editor state. The real keyboard journey
passed at 1280 and 390 pixels, including native Space checkbox activation and
persisted role selection. Build/typecheck and structural/package quality pass.

The cross-origin browser verifier now requests and checks a non-identity scope.
Desktop and mobile passes exist, but intermittent refusals also reproduced.
The separate local-browser-deadlines audit records a captured early-consent
clock failure and its fix, measured clock drift during later failures, and
controlled-clock browser verification with explicit rollback refusal. Earlier
failures are not all attributed to one cause by inference.
No scanner or full security certification is claimed.

Applications must enforce decisions over their own resources; this is not a
network OIDC service or an authorization grant for Host, connectors or vault
data. Same-origin scripts in an already-unlocked older issuer tab retain that
tab's authority. Close old tabs and reload on upgrade. See ADR 0108.
