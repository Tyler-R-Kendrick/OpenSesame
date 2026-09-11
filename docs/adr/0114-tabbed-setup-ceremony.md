# ADR 0114 — A tab per concern: the tabbed setup ceremony

- Status: Accepted
- Date: 2026-09-11
- Supplements: [ADR 0090](0090-static-frontend-complete-without-backend.md)
  (setup is optional, never a gate), [ADR 0078](0078-external-idp-as-identity-service.md)
  (the ways-in allowlist), [ADR 0113](0113-vault-self-authenticator-second-step.md)
  (the mfa tab's authenticator road)
- Supersedes: the "one screen, one question, no stepper" note in
  `docs/design/first-run-setup/`

## Context

Deployment setup asked a single question — *how do people sign in?* — and
deliberately nothing else. That answered identity, but a deployment has more
concerns a first operator legitimately arrives with: where backups persist,
who runs the support model, which second steps exist, and what the vault
syncs with. Each was discoverable only by already knowing which Settings
panel owned it. The unlock screen, meanwhile, had already grown the layout
this asks for: a tab per method with a steps rail naming how much is left.

The hard constraint is unchanged: **setup is optional, and everything on it
must be skippable** — a static deploy is complete with none of it answered
(ADR 0090). A five-tab ceremony must not become a five-screen wall.

## Decision

The operator road of `SetupScreen` is a tab per concern, in the unlock
screen's idiom: a steps rail ("1 · Backups" … "5 · Sync"), a tab strip of
plain `role="tab"` buttons in Tab order, one panel per tab, and the shared
`.go` commit.

1. **backups** — encrypted git history (the `history` capability binding:
   GitHub, local password-store, GitLab), the daemon on this machine (build
   instructions plus its address as a *suggestion*, never a default), and the
   offline-export pointer.
2. **ai** — the model-provider presets (Ollama, LM Studio, Anthropic, OpenAI,
   OpenAI-shaped), the same list Settings › Model offers, persisted the same
   way; an API key is never asked for.
3. **identity** — the ways-in allowlist (`WaysIn`), unchanged: the one
   question the old screen asked, kept whole as one tab.
4. **mfa** — a tour, not a form: authenticator app (with this vault able to
   supply its own code, ADR 0113), email code, text message — each enrolled
   from Settings › Security once a vault exists to guard.
5. **sync** — the `cloud_secrets` and `password_managers` capability
   bindings (1Password, Azure Key Vault, …).

Rules that keep the ceremony honest:

- **Every answer writes `settings.v1` as it is made**, exactly as the
  equivalent Settings panel would write it — the ceremony asks, the setting
  keeps. There is no staged state, so there is nothing to undo.
- **A connector is configured in place, Nango-style.** Clicking Connect on a
  card opens the provider's ceremony in a **new tab**; the Host's callback
  page posts the `opensesame:connection` event notification back to the
  opener and closes itself, and the card observes that notification (and
  polls, in case the message is lost) through the same `awaitConsent` the
  Connections page uses — flipping to Connected once the connection is
  established. Nobody is told to "go finish this in Settings".
- **Every tab is skippable, and "Skip all" finishes the tour.** The foot is
  three honest actions: **Skip** (records the tab as skipped and advances),
  **Next** (just browses forward — the record hears nothing), and the `.go`
  **Finish setup** commit. Skips are recorded on the `SetupRecord`
  (`skipped?: string[]`), so "looked and passed" stays distinct from "never
  looked".
- **A tab may not pretend to configure what it cannot.** Where no Host
  answers, the card says *Needs a Host* and withholds Connect, because a
  button that can only fail is a lie about the road; mfa enrollment needs a
  sealed vault, so that tab tours the roads instead. A road that knows its
  concern (the unlock screen's no-way-in notice) lands on its tab directly
  via `SetupScreen`'s `step` prop.

The rail and the tab strip pin to the frame above the scrollport — the first
render put them inside the scrolling body, which stranded the later tabs on a
phone.

The join road is untouched. `KeepIt` rides beneath the active step — not a
sixth tab, because installing has no wrong answer and never gates the commit.

## Consequences

- `verify:static`'s setup leg walks the tabs: five tabs opening on backups,
  the identity tab keeping the original question, "Skip all" returning to
  sign-in.
- The design-lint contract (`screens/setup/control-contract.test.ts`) still
  holds: the terminal commit is `.go` with its verb.
- Tutorial targets `setup.ways` (now on the identity tab), `setup.keep` and
  `setup.finish` keep their bindings.
- Old `SetupRecord`s read cleanly: `skipped` normalizes to `[]`.
