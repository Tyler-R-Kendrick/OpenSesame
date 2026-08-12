# ADR 0033: Federated identity admission

## Status
Accepted

## Context
ADR 0012 settled how *clients* are admitted. Nothing settled how *humans* are admitted.
`POST /principals/provisional` mints a principal from an unauthenticated request, and the
PWA's first run creates a device vault before any identity exists at all. The result is that
a durable principal can come into being without any issuer ever having asserted that the
person exists.

ADR 0016 already decided that OpenSesame does not implement SAML or LDAP and that its
upstream contract is generic OIDC. `packages/auth-upstream` carries the machinery for that —
a Better Auth factory, an upstream OIDC provider registry, a principal mapping store, and a
deliberate refusal to auto-link on email — but only the local mock IdP was ever registered,
so the machinery has never carried a real upstream.

Anonymous and provisional sessions are a designed capability, not an accident: they let a
visitor act before deciding to be someone. Removing them would remove a product behaviour.
What has to change is which of the two paths is the default, and what a provisional session
is allowed to become on its own.

## Decision
1. **A durable principal originates from a trusted upstream broker.** It is created only by
   presenting an assertion that OpenSesame verified against that broker's published keys.
   No endpoint mints a durable principal from unauthenticated input, and no endpoint accepts
   a caller's word for who they are.
2. **Trust is an explicit allowlist, keyed by issuer.** A broker is trusted because it is
   configured, not because it can complete a flow. An assertion from an unlisted issuer is
   refused even when its signature verifies, since a valid signature only proves who signed
   it. `shoo.dev` is the production entry; the mock IdP is the test entry so the suite stays
   hermetic and never depends on a third party being reachable.
3. **Provisional sessions survive, but stop being the default.** A visitor may still act
   provisionally. What a provisional session may not do is promote itself: becoming durable
   requires a broker assertion, and the promotion preserves `principalId` so nothing the
   visitor did is orphaned by signing in.
4. **Federation comes before device encryption.** The PWA's first run asks who you are before
   it asks for a master password. The vault is device encryption rather than an account, so
   it is still created locally and still never leaves the device — it is simply no longer the
   thing that brings a user into existence.
5. **Canonical identity remains OpenSesame's.** As in ADR 0011 and `docs/identity-linking.md`,
   `Principal.id` is never the broker's subject, never an email, and does not change when a
   further identity is attached. A broker asserts *who showed up*; it does not name them.

## Consequences
- Self-service account creation no longer exists. A deployment with no configured broker can
  admit no durable users, which is the intended failure: it is better than admitting anyone.
- The mock IdP gains a second role. It is no longer only an upstream for tests, it is the
  reference implementation of what a trusted broker must do.
- Losing access at the broker means losing sign-in. That is inherent to federation and is
  stated in the UI rather than hidden.
- Provisional capacity limits and TTLs in `apps/control-plane/src/routes/principals.ts` still
  apply, and matter more now that provisional is the only unauthenticated path.

## Related
- ADR 0007 — dual-plane identity/authority
- ADR 0011 — pairwise subject storage
- ADR 0012 — client admission modes
- ADR 0016 — generic OIDC upstream contract
- ADR 0034 — origin-brokered sign-in for static sites
