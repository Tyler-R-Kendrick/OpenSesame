# ADR 0034: Origin-brokered sign-in for static sites

## Status
Accepted

## Context
A static site has no backend, so it has nowhere to keep a client secret and nowhere to run a
token endpoint. Shoo solves this by deriving the client id from the redirect origin
(`origin:https://example.com`), requiring PKCE S256 on every flow, serving a CORS-enabled
`/token` so the browser itself can exchange the code, and signing an ES256 `id_token`
carrying a per-origin `pairwise_sub` that anyone can verify from published JWKS. ADR 0012
already called this the "origin profile" and accepted it as a mode, but only its guardrails
were built: the policy validates such a client, while `oauth-clients.ts` refuses to create
anything except a pre-registered one. Nothing derives a client from an origin.

The deployment target is GitHub Pages, which serves static files. It has no server, so it
cannot hold a signing key, and any key shipped to the browser is a published key. An
OpenSesame deployment on Pages therefore cannot be an issuer, however much the surrounding
flow looks like one.

Local development makes this sharper. Each `http://localhost:PORT` is a different origin, so
under Shoo's own rule each port is a different client with a different `pairwise_sub` — the
same developer is a different person on every port, and re-consents to Google every time.

## Decision
1. **The Pages deployment brokers an identity it did not mint.** It signs the human in
   against a trusted upstream broker (ADR 0033) at one stable origin, and hands that
   upstream's `id_token` to local relying parties. It does not re-sign, because it has no key
   it could sign with honestly.
2. **The broker origin is the audience, and relying parties are told so.** The token an RP
   receives carries `aud: origin:<broker origin>`, not the RP's own origin. An RP verifies
   against the upstream's JWKS with the *broker's* audience. Documentation and the example RP
   both do this explicitly, because an RP that verified its own audience would reject every
   valid token and one that skipped the check would accept anything.
3. **Consent is per RP origin, and the human gives it.** An origin receives the identity only
   after being approved by name, and approval is remembered and revocable. This is what makes
   the flow safe to offer at all: possession of the token is equivalent to being the user at
   the broker origin, so it is released deliberately rather than to whoever asks.
4. **Relying parties derive their own subject.** An RP that wants Shoo's non-correlation
   property computes `SHA-256(pairwise_sub || ':' || its own origin)` from the token it just
   verified. Deriving it locally rather than being told it means the RP trusts only what it
   verified, and two RPs cannot recognise the same person.
5. **The broker returns the assertion directly, and does not pretend to be an OAuth server.**
   PKCE S256 governs the upstream leg, where a real CORS token endpoint exists and a code is
   genuinely exchanged. Between RP and broker there is no endpoint to exchange against — a
   static site cannot serve `POST /token` — so there is no code, and a code challenge there
   would be ceremony protecting nothing. Delivery is by `postMessage` targeted at the
   approved origin, never `"*"`, with a single-use TTL-bound `state` binding the response to
   the request. A fragment redirect is offered only for browsers that block popups, and is
   documented as the weaker option because it puts the assertion in the URL.
6. **This profile is for local and low-stakes relying parties.** A correctly audienced,
   per-RP token requires an issuer with a key, which requires a server. That is a hosted
   deployment concern and deliberately out of this slice; the profile says so rather than
   implying it scales to production third parties.

## Consequences
- A developer signs in once at the Pages origin and every local port reuses it, with one
  stable identity instead of one per port.
- Anything holding a passthrough token can act as that user at the broker origin. Consent,
  short lifetimes and explicit revocation bound the exposure; the alternative — re-signing
  per RP — is unavailable without a server, and pretending otherwise would be worse.
- The upstream broker must serve CORS on its token endpoint, since the exchange happens in
  the browser. This is true of `shoo.dev` and is a stated requirement for any other.
- No client registration exists for local sites. The origin is the client id, so there is no
  dashboard step and nothing to keep in sync.

## Related
- ADR 0012 — client admission modes (origin profile)
- ADR 0033 — federated identity admission
- `docs/architecture/federated-signin.md` — the wire contract
