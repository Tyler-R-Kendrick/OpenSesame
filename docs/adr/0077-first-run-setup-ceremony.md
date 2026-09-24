# ADR 0077 — First-run setup: the anonymous visitor is the operator

Status: Accepted — §2, §3 and §6's stepper superseded by
ADR 0078 ([an external IdP is the identity service](0078-external-idp-is-the-identity-service.md));
§1 and §4's `setupRequired` gate superseded by
ADR 0090 ([the static front end is complete without a backend](0090-static-frontend-complete-without-backend.md)) —
setup is optional and never runs before sign-in
Date: 2026-08-31
Supplements: ADR 0017 ([host/client product topology](0017-host-client-product-topology.md)),
ADR 0033 ([federated identity admission](0033-federated-identity-admission.md)),
ADR 0055 ([provider registry, BYO and org sign-in](0055-provider-registry-byo-and-org-signin.md)),
ADR 0060 ([identity screen IdP brokering](0060-identity-screen-idp-brokering.md)),
ADR 0065 ([agent-surface parity](0065-agent-surface-parity.md))

## Context

`apps/pages` ships to GitHub Pages as a static bundle. A static deploy bakes no
`VITE_*` endpoints, and `os-runtime-config.json` is written by
`scripts/deploy-pages.sh` only where an operator ran it — so the common case for
a fresh deployment is: **no Identity API, no Host API, no daemon.**

The screen that met that case reported it. `UnconfiguredIdentityNotice` rendered
a `note--warn` block at the top of the unlock screen saying sign-in was
unavailable on this deployment, with an inline URL field and the instruction to
"ask whoever runs your OpenSesame deployment for this address".

On a phone that block was most of the first viewport. Three things were wrong
with it, and only the first is cosmetic:

1. **It was the largest thing on screen and could not be acted on.** The one
   control it offered wanted an address the reader did not have. Below it sat
   sign-in options that would redirect into nothing, and an Unlock tab for a
   vault that did not exist.
2. **It framed a fresh install as a fault.** A deployment nobody has configured
   is not broken; it is new. Amber is the wrong colour for "you have not
   answered this yet", and "ask whoever runs your deployment" is the wrong
   instruction to give the person who *is* whoever runs it.
3. **The configuration it asked for was one field of several.** The Identity API
   alone does not make a working deployment. An upstream IdP is registered
   *through* it (ADR 0055/0060); the Host API is a separate address; a daemon
   paired over a tailnet writes all three at once. Those lived in Settings,
   behind a vault the visitor could not create yet without first walking past
   the warning.

## Decision

### 1. The first visitor to an unconfigured deployment is treated as its operator

Not as a user who has arrived somewhere broken. `apps/pages/src/screens/
SetupScreen.tsx` runs **before** the unlock screen and asks two questions.

### 2. Sign-in leads, and it already has a working answer

The first cut of this ceremony had four steps, and led with an OpenSesame
identity service URL, then a Host URL, then a daemon on the operator's own
machine. That had the dependency backwards, and review said so.

`TRUSTED_UPSTREAMS` compiles a **browser-capable** upstream into every build —
the public broker on the open web, the reference IdP on loopback. A browser can
run that entire code flow itself. **Sign-in therefore works on a deployment
nobody has configured**, and demanding three self-hosted addresses first made
the common case walk past fields it had no answer for to reach a service it did
not need.

So step one is the choice, and infrastructure appears only for the answer that
requires it:

| Road | Needs an identity service? |
|------|----------------------------|
| What this build already brokers — **selected by default** | No |
| Your own provider (WorkOS, Okta, Auth0, Better Auth, any OIDC issuer) | Yes — asked for *here*, in place |
| No accounts — a local vault | No |

The OpenSesame identity service is one option among the providers, never a
prerequisite for them. Self-hosting anything is a road, not the road.

Nothing here is new product surface. `presetIssuer` and `registerByoProvider`
are the functions the Identity ceremony and the sign-in sheet already call.

### 3. Everything else is one optional screen

Host, machine pairing and the Mobile MFA app are still configurable on first
run — an operator who runs them needs somewhere to say so — but as rows that
expand in place, closed, each showing what it already holds so the screen reads
without opening anything. The machine row **mounts `ConnectThisMachine`
itself** rather than reimplementing the hardest flow in the app.

### 3. Every step is skippable, and every skip states its cost

A local-only vault is a legitimate outcome of setup, not a failure of it. The
Host step says in the product's own terms what an empty answer costs — no
ConnectionRefs, no receipts, no agent-facing authority — instead of "some
features may not work". `setup.v1` records `identity: "local-only"` so the app
can tell "nobody has set this up" from "the operator deliberately runs this
without one".

### 4. Setup leaves behind a decision, never an address

`apps/pages/src/lib/setup.ts` persists only *that* the ceremony was answered and
*what was chosen*. Endpoints stay in `settings.v1`, which remains the single
source of truth for what this app talks to. The record is plaintext beside the
vault — the ceremony runs before any vault exists, so there is nothing to seal
it with — and carries no credential, only preset names and booleans.

`setupRequired()` is false if any of three things is true: the record exists, a
vault is already sealed on this device (every build before this one let people
seal one without a ceremony), or an Identity session is live (only reachable
through a working Identity API). A corrupt record reads as no record: the
ceremony runs again, which is survivable; refusing to boot is not.

### 5. Unlock is withheld, not disabled, while there is nothing to unlock

`unlockViable()` is the named rule the unlock screen's tab row now reads. Only a
sealed vault can be unlocked; with nothing on the device the tab is a promise
the app cannot keep. It is withheld rather than greyed, because a disabled
control still asserts the action exists and merely is unavailable right now —
a different claim, and an untrue one.

Where an Identity API is genuinely unset, the sign-in stage carries one sentence
and a button into setup, in place of buttons that would redirect into nothing.
The unlock screen's foot names the deployment this app is pointed at and offers
`Deployment setup` — quiet, because on a working deployment it is a fact rather
than a problem.

### 6. The commitment lives at the bottom of the phone — as an ink square

One question per screen, with the terminal commit pinned to a foot bar in the
same place on every step, and a rail that both reports progress and jumps. Above
`40rem` the frame centres and the foot unpins: on a wide viewport the action
belongs with the content it commits, because there is no thumb to reach with.

That commit is the shared `.go` control — an ink square carrying the glyph of
what it does, its sentence beside it in the margin voice — not a wide text
button. The first cut used a full-width `.btn--primary`, which is the *other*
primary pattern (the one for actions inside a card) and read as a banner. Both
patterns are now named in [`docs/design/controls.md`](../design/controls.md),
`.go` is defined once in `styles.css`, and `scripts/design-lint.mjs` holds new
code to the contract from the `pre-commit` hook and a Claude Code `PostToolUse`
hook.

The alternative — one scrolling checklist of expand-in-place rows, which is the
connectivity bar's existing vocabulary — was drawn and rejected: on a phone an
expanded row pushes the finishing action off screen, so the one control that
ends setup moves whenever something opens. Both are on the canvas at
`docs/design/first-run-setup/`.

### 7. The ceremony is never agent-reachable

`setup.first_run` is registered in `packages/capability-registry` with the PWA
surface `lib/setup.ts:setupRequired` and an explicit WebMCP exclusion citing this
ADR. The reason is not squeamishness about ceremonies: answering "where does
identity live" chooses the issuer that will authenticate every later human on
this device. An agent that could answer it could point the deployment at an
identity service of its own choosing before any person had signed in. Setup is a
human decision, on the human's device, taken once.

## Consequences

- A fresh deployment's first screen is answerable. The amber block is gone, and
  with it `UnconfiguredIdentityNotice` and its test.
- **Setup can be finished with nothing typed.** Two taps on a fresh deployment,
  because the road that needs no configuration is the one already selected.
- Existing installs are untouched: a device with a vault never sees setup, and
  reaches it only by asking for it from the unlock screen's foot.
- `setup.v1` joins the plaintext boundary documented in [ADR 0063](0063-encrypted-vfs-tombs.md) alongside boot
  endpoints, vault header params, lockout counters and tomb names.
- Setup does not seal a vault. It hands back to the sign-in screen, which owns
  that ceremony (ADR 0033 §4) — one decision per screen holds across the seam
  between the two.
