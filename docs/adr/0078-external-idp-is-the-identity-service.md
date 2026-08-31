# ADR 0078 — Setup is the sign-in allowlist, and an external IdP *is* the identity service

Status: Accepted
Date: 2026-08-31
Amends: ADR 0077 ([first-run setup ceremony](0077-first-run-setup-ceremony.md)) §2, §3 and §6
Supplements: ADR 0033 ([federated identity admission](0033-federated-identity-admission.md)),
ADR 0055 ([provider registry, BYO and org sign-in](0055-provider-registry-byo-and-org-signin.md)),
ADR 0060 ([identity screen IdP brokering](0060-identity-screen-idp-brokering.md)),
ADR 0017 ([host/client product topology](0017-host-client-product-topology.md))

## Context

ADR 0077 replaced an amber "not connected to an identity service" block with a
setup ceremony, and its second cut moved the OpenSesame identity-service URL off
the front and behind the one road that "needed" it. Review rejected that too,
correctly, on two counts.

**The URL had not been removed, only hidden.** Choosing WorkOS or Okta still
meant typing an OpenSesame identity-service address first, because BYO
registration ran server-side through `POST /v1/federated/byo-upstreams`. So
"bring your own provider" was really "stand up our control plane, then bring
your own provider". And the write-out proved it: a deployment could be signing
people in perfectly well and still read

```
Identity service        not set
```

because "identity service" meant *an OpenSesame control plane*, not *the thing
that identifies people*. Naming an external provider was, in the app's own
readout, indistinguishable from configuring nothing.

**Two of the remaining questions were not questions.** "This machine" pairs a
daemon on a host the visitor may not have; "Host API" only records that somebody
decided to self-host. Neither is something a first-time visitor knows or needs.

**And a deployment is rarely one provider.** Google for everybody, an org's own
IdP for staff, is the ordinary shape. A single-select road picker could not say
that. Worse, the sign-in screen was not reading the answer at all: it offered
every road it could name — the compiled broker, a bring-your-own globe, an email
magic link, guest, an organisation lookup — whether or not the deployment had
anything behind them. Most of those need an Identity API, so on a deployment
without one they were buttons that could only fail.

Underneath both is one factual matter that had never been written down: the
Identity API was treated as a *prerequisite* for external providers when for
most of them it is not one.

## Decision

### 1. A browser can run an external provider's sign-in itself, so it does

`beginSignIn` already runs authorization code with PKCE from the tab. What
confined it to `TRUSTED_UPSTREAMS` and the configured Identity API was not the
protocol — it was one hard-coded value: the client id, always
`origin:<origin>`, a profile that only our own brokers mint on sight. A real
Okta org, Auth0 tenant or Entra directory rejects it as an unknown client.

So `TrustedUpstream` gains an optional `clientId`, and it travels with the
upstream through the authorize request, the token exchange, and the `aud` check.
An operator supplies two values —

- the **issuer**, built by the same `lib/idp-presets.ts` rules the Identity
  ceremony uses (ADR 0060), so an Okta domain means the same thing in both
  places, plus a new Entra tenant rule and the bare-issuer road;
- a **public client id**, registered at their provider against the redirect URI
  the screen shows them verbatim

— and that is a complete, working identity service. `settings.v1` gains an
`idp` record holding exactly those, plus a label. Neither is a credential:
PKCE and the registered redirect URI are what bind the flow, and there is no
secret for a static bundle to fail to keep.

The provider must serve CORS on its token endpoint, which is what registering
this app as a single-page or public client means in every provider's own
console. That requirement is stated on the screen and reported plainly when a
provider refuses, rather than dead-ending.

### 2. Naming a provider widens trust by exactly one issuer

ADR 0033 §2 compiles the trust list in because an issuer must never become
trusted merely by completing a flow. That still holds. `isOperatorIdpIssuer` is
a different case, and the same one `isBrokeredIssuer` already occupies:
somebody with the deployment's settings durably said *this one speaks for my
users*. It admits the one stored issuer and nothing else — not "every Okta",
and never whatever a response happens to claim. It is checked in `readIdentity`
(admission) and again in `loadSession` (so trust withdrawn between sessions
takes a stored identity with it).

`pairwise_sub` is not demanded on this road. That claim exists because a broker
serving many unrelated relying parties would otherwise hand them all the same
subject to correlate on; an operator's own directory is not that — they are the
relying party — and no real provider mints a claim of that name, since it is our
brokers' contract rather than OIDC's. Correlation protection downstream is
untouched: an origin this app brokers *to* still receives the per-origin subject
`derivedSubjectFor` computes, whatever the source.

### 3. Setup builds an allowlist, and the sign-in screen renders exactly it

The screen is a **list of ways in**, added and removed, not one choice:

| Way in | What it needs |
|--------|---------------|
| What this build brokers | nothing — present on arrival, removable |
| Any number of the operator's own providers | an issuer and a public client id, each |
| An OpenSesame identity service | its URL |

`settings.signIn` holds `{ builtin, providers[] }`, one entry per issuer, and
`SignInPanel` renders from it and from whether `identityApi` is set. The
consequence is the rule this ADR is really about: **a road nobody configured is
not offered.** With no identity service there is no bring-your-own globe, no
magic link, no guest button and no organisation lookup, because every one of
those is an Identity API ceremony and would only fail. Remove everything and
the screen honestly offers one thing: a local vault.

The OpenSesame identity service still earns its place — organisation SSO and
SAML, LDAP, magic links, guest sessions, and whatever its own catalog brokers
are legs a browser genuinely cannot run alone. It is a peer in that list, never
a prerequisite for the others.

The readout names each way in, and **"not set" is never shown for a road that
signs people in.**

### 4. What the Host does that a PWA cannot — and why setup does not ask

The Host API is not on this screen. The honest reason is worth recording,
because "what does the host even do that can't be done in a PWA broker app?" is
a fair question and the answer is narrower than the old ceremony implied.

For one person using this browser, the PWA is complete: it holds the vault, runs
sign-in, and talks to connectors itself. The Host earns its place in exactly
three places, all of which are outside the tab:

1. **Callers that are not this browser.** `apps/cli`, `apps/daemon`,
   `apps/mcp-host` and the git/docker/AWS/kubectl credential helpers all obtain
   authority from the Host. A PWA cannot serve them: it has no address, no
   lifetime they can depend on, and no way to be running when they run.
2. **Authorization by brokering rather than by exposure.** ADR 0005's whole
   point is that holding a `ConnectionRef` never implies permission to resolve
   the credential behind it; the Host makes the upstream call itself, against an
   egress allowlist, and returns a response plus a signed receipt
   (`crates/invoke-through`). A browser cannot do that on another party's
   behalf — and for its own calls, CORS decides where it may go, not us.
3. **Work with no tab open.** The lifecycle/expiry scanner (ADR 0074),
   credential rotation, certificate renewal under key custody (ADR 0075) and the
   backup actor (ADR 0039) all run on deadlines that do not wait for somebody to
   open a page.

None of those is a thing a first-time visitor is deciding. So the Host API stays
in Settings → Endpoints, where an operator who runs one goes looking anyway, and
setup neither asks for it nor records it.

The daemon pairing goes further: it is removed from setup outright. It exists so
a deployment that cannot reach `127.0.0.1` can reach a machine over a tailnet —
a situation an operator discovers when they have that machine, not on first run.
`ConnectThisMachine` is unchanged and still reachable where it belongs.

### 5. One question, so no stepper

With the Host, the machine and the MFA URL gone, setup asks one thing. A
progress rail over a single step is furniture, so it is gone with the counter,
the Skip and the Back — as is `SETUP_STEPS`. `SetupRecord` becomes
`{ ways: string[], service: boolean }`: which roads were taken, so a later
screen can tell "nobody set this up" from "the operator deliberately runs it
this way". Records written by the older ceremonies still read as records — the
fields they carry are simply ignored, which is all they were ever read for.

The commit is unchanged: the shared `.go` ink square with its verb beside it,
pinned to the foot bar, per [`docs/design/controls.md`](../design/controls.md)
and enforced by `pnpm lint:design`.

### 6. A provider is verified before it is kept

`Use <provider>` fetches the issuer's discovery document and keeps the record
only if it answers and names itself honestly. Saving an unreachable provider
would re-create the exact bug this screen exists to remove: a deployment that
reads as configured and dead-ends at the first sign-in.

## Consequences

- Bringing Google, Microsoft Entra ID, WorkOS, Okta, Auth0, Better Auth or any
  OIDC issuer needs **no OpenSesame service of any kind** — not a Host, not an
  identity service, not a daemon. Issuer plus client id, verified, and the
  sign-in screen offers it.
- A deployment can have as many ways in as it wants, and the sign-in screen
  shows those and only those. A provider nobody configured is never a button.
- The readout can no longer say "not set" about a configured deployment.
- First-run setup is one screen and can still be finished with nothing typed.
- `settings.v1` carries a `signIn` record. Its providers are read back only
  whole: an issuer that is not https (or loopback http), a missing client id, or
  a second entry for an issuer already listed is dropped — so a truncated write
  can never become a trusted issuer with nothing behind it, and "remove" is
  never ambiguous. An absent record reads as the shipped default (the compiled
  broker, nothing else), which is what every install that predates this ADR
  gets.
- ADR 0077 §2, §3 and §6's stepper are superseded by this ADR; the rest of it —
  the operator framing, `setupRequired`, `unlockViable`, the endpoint/decision
  split, the agent-surface exclusion, the ink-square commit — stands unchanged.
