# ADR 0079 — Agent-run registration ceremonies: the setup cliff, and who climbs it

Status: Proposed
Date: 2026-08-31
Supplements: ADR 0076 ([autonomous web-login rotation](0076-autonomous-web-login-rotation.md)),
ADR 0078 ([live session observation](0078-live-session-observation.md)),
ADR 0005 ([ConnectionRef over SecretRef](0005-authority-handle-connectionref.md)),
ADR 0039 ([event-driven GitHub backup](0039-event-driven-github-backup.md)),
ADR 0052 §12 ([relying-party data ships checked in](0052-password-manager-ecosystem-bridging.md)),
ADR 0055 ([provider registry, BYO and org sign-in](0055-provider-registry-byo-and-org-signin.md)),
ADR 0065 ([agent-surface parity](0065-agent-surface-parity.md)),
ADR 0077 ([first-run setup ceremony](0077-first-run-setup-ceremony.md))
References: GitHub App Manifest flow, RFC 7591 (OAuth 2.0 Dynamic Client
Registration), RFC 8414 (Authorization Server Metadata)

## Context

`OpenSesame`'s value is gated behind ceremonies only a developer can complete.
ADR 0039's backup path reads, in full: register the GitHub App, install it on
the org, then set the backup target. ADR 0055's BYO providers need an OAuth
client registered at an IdP. The certificate issuers need accounts. ADR 0077
made the *first* screen answerable by an anonymous visitor; everything behind it
still asks for developer work.

This is the same shape as ADR 0076's problem — a third party's settings page,
no API, no way through but a human — and it invites the same answer. That
answer is mostly wrong here, and the reason is worth stating before any design.

**The registration form is not the hard part, and for GitHub it is already
solved.** `apps/gateway/src/routes/github_app.rs` implements GitHub's App
Manifest flow: `build_manifest` posts a preconfigured manifest,
`convert_manifest_code` exchanges the one-time code, and the response carries
the app id, the private key and the webhook secret. `github_webhook.rs` then
captures the installation id. Nobody fills fifteen fields and nobody downloads
a `.pem`. Driving a browser to fill a form GitHub offers an endpoint for would
be more fragile, more dangerous, and would discard a supported path — the exact
inversion of ADR 0008's rule about preferring mature mechanisms over
hand-rolled ones.

What is actually still hard, in that flow and every flow like it:

- **The preconditions.** Having an account at all, being signed in, and being
  signed in as the right identity for the right org.
- **The click-through.** GitHub's create page and install page are consent
  screens. They are supposed to be human. What is not supposed to be human is
  *finding* them, knowing which org to pick, and knowing that installing is a
  separate step from registering.
- **Every provider that has no manifest flow.** RFC 7591 covers the OAuth
  case where a server implements it; most consumer-facing dashboards do not.
- **The last mile.** A registered app that was never installed, or installed
  on the wrong org, fails later and looks like a bug in `OpenSesame`.

So the ceremony worth automating is the orchestration, not the form.

## Decision

### 1. Ceremonies resolve down a ladder, and the provider's own flow always wins

Mirroring ADR 0076 §2 deliberately — the discipline is the point, not the
symmetry.

| Tier | Mechanism | Default |
|------|-----------|---------|
| C0 | **Provider-native registration.** GitHub App Manifest, RFC 7591 Dynamic Client Registration discovered via RFC 8414, or any documented registration endpoint. | on |
| C1 | **Deterministic recipe.** A signed, checked-in step IR over the provider's own UI, replayed with no model in the loop. Used for the parts C0 does not cover — sign-in state, org selection, the install step. | on |
| C2 | **Agentic.** A model plans against a redacted DOM and calls the §2 tools, for a provider with no C0 path and no recipe yet. | gated |
| C3 | **Blocked.** Notify, park, and open a teaching session (ADR 0076 §4), which produces a recipe and returns the provider to C1. | on |

A provider with a C0 path is never driven at C1 or C2 for the part C0 covers.
That is not a preference; a run that scrapes a form a provider offers an
endpoint for is a bug against this section.

### 2. One executor, pointed the other way

Rotation *writes* a credential into a third party. Registration *captures* one
out of it. Same recipe schema, same step IR, same observation log, same control
lease, same `agent.*` feed. Two directions, not two subsystems.

The tool surface gains exactly one verb, and its shape is the inverse of the one
ADR 0076 §1 already defines:

- `fill_credential(ref, selector) -> {ok}` — the agent names *which* credential
  and *where it goes*, never *what*.
- `capture_credential(slot, selector) -> {ok, digest}` — the agent names *which
  slot* and *where the value is*, never receiving it. A deterministic controller
  reads the node and seals the value straight into the vault.

`capture_credential` is not `read_field_value` wearing a hat, and the difference
is exactly the property ADR 0076 §3 constraint 1 protects: no secret value
reaches a model context, a transcript, a screenshot or a recording. The captured
value goes from the DOM to the seal, never through the model, and the returned
digest is not redeemable — the same non-redeemable-handle shape as ADR 0005's
ConnectionRef. There is still no tool that returns a value, so there is still no
check that has to deny one.

### 3. Capture targets are declared by the recipe, never chosen at runtime

ADR 0076 already pins fill targets: "Recipe pins the target; agent may only name
targets the recipe declares." For capture the same rule is **more** load-bearing,
because a model free to choose what to capture could capture the page's session
cookie and seal it as a client secret.

So a recipe declares typed **capture slots** — `app_id`, `private_key`,
`client_secret`, `webhook_secret`, `installation_id` — each with an expected
shape, and a capture step may only name a declared slot. A capture whose value
does not match the slot's shape aborts the run.

**Downloads are a first-class step, not a special case.** A private key
frequently arrives as a file rather than a DOM value, so the step IR carries
`capture_download(slot, expect: {content_type, max_bytes})`. The download is
intercepted in the browser context and sealed; it never lands on a filesystem
the user, the agent, or another process can read. The declared shape is
fail-closed: a `private_key` slot handed an HTML error page aborts, because the
alternative is sealing a login page as a signing key and discovering it at first
use, months later, during a backup.

### 4. The runner is local by default here, and that reverses ADR 0076 for a reason

ADR 0076 rejected driving the browser on the user's own device as its primary
runner, because a scheduled rotation must run while the machine is closed. A
registration ceremony is the exact opposite case: **the user is present by
definition** — they are setting the product up, and the ceremony exists because
they are stuck.

Every advantage ADR 0076 listed for the local runner therefore applies with
nothing traded away: the user's real network position, their device reputation,
and WebAuthn step-up that works. And one more that matters more than all of
them:

**A local ceremony never needs the user's password for the provider.** They are
already signed in, in their own browser. The agent drives a session the user
established themselves, so no credential is handed to a sandbox and no sandbox
establishes a session. ADR 0076 §7's residual — a remote sandbox holding a live
first-party session it could use to take the account over — does not arise,
because there is no remote sandbox.

The residual that replaces it is real and smaller, and is stated rather than
implied: **an agent is driving the user's logged-in browser.** It is contained
by §5's refusals, by the ceremony being scoped to one origin for one run, and by
ADR 0078's live preview being on by default here rather than optional — a
ceremony the user is present for is one they should be watching.

The runner contract is ADR 0076 §8's, unchanged: transport-level, so the browser
extension (`apps/browser-extension`) is a second implementation rather than a
fork. Its origin permission is per-ceremony, per-origin and time-boxed, revoked
at completion. A standing `<all_urls>` grant to satisfy a setup step would be a
larger authority than anything else this product asks for.

### 5. What a ceremony must never do

- **Never accept terms.** A person accepts a provider's terms of service, not an
  agent. The agent may fill a signup form; the human submits it. This is not
  legal caution dressed as design — an agent that can accept terms can enter the
  user into agreements they never read.
- **Never create an account unattended.** C2 requires the user present and
  watching, which §4 already implies and this makes explicit.
- **Never exceed the permissions the recipe declares.** A GitHub App form has
  permission checkboxes; the recipe declares the exact set, and the run
  **verifies after** rather than trusting the form — a registration that came
  back with more authority than was asked for aborts and reports.
- **Never register against an org the user did not name.** Org selection is a
  consent step, and picking one on someone's behalf is picking whose data is at
  stake.
- **Never solve a challenge.** ADR 0076 constraint 4 carries over whole.

### 6. Success means a round trip, not a green form

A ceremony reports success only after **using** the captured credential once —
minting an installation token, listing installations, calling the provider's
"who am I". ADR 0047's "a test is an oracle" applied to onboarding.

The failure this prevents is specific and expensive: a ceremony that reports
success on a form submission, and a user who discovers months later that backup
never worked because the app was registered and never installed. That is
ADR 0052 §11's silent failure with a longer fuse.

### 7. Ceremony recipes are catalog data

Unlike rotation's long tail of consumer sites, there are dozens of providers and
`crates/connection-broker/src/catalog.json` already enumerates them. A ceremony
recipe is therefore catalog data: checked in, reviewed, signed, versioned
alongside the provider it belongs to.

Checked in rather than fetched, per ADR 0052 §12 — "a lookup is a disclosure".
Asking a server for the ceremony recipe for `provider-x` tells that server which
provider this user is onboarding, which is precisely the kind of question the
sealed store exists so nobody has to answer.

### 8. The receipt enumerates what was created

A rotation changes a value. A ceremony **creates authority** at a third party:
an app, a set of permissions, an installation on an org. ADR 0076 §7's
account-security diff is a side effect there and the *subject* here, so the
receipt names what now exists, on which account, with which permissions, and
what `OpenSesame` holds for it — in the user's words, not the provider's field
names.

### 9. Observation is inherited, and on by default

ADR 0078 applies unchanged: one sealed log, three lanes, admitted frames,
untrusted thoughts, a single-holder control lease, owner-only attach. Two
differences, both narrowing:

- Live preview defaults **on** for a ceremony, because the user is already
  present and the run is creating authority on their account.
- A blocked ceremony publishes `agent.run.blocked` like any other run, so the
  notification path built for rotation covers onboarding with no new channel.

### 10. Agent-surface mapping

Per ADR 0065:

| Capability | cli | mcp_host | webmcp |
|---|---|---|---|
| `ceremonies.catalog_read` (which providers have a recipe, and at what tier) | `opensesame ceremony list` | `ceremony_catalog_read` | `opensesame_ceremony_catalog` |
| `ceremonies.status_read` | `opensesame ceremony status` | `ceremony_status_read` | `opensesame_ceremony_status` |
| `ceremonies.open` | `opensesame ceremony run` | excluded — starts a run that creates authority on the user's account, §10 below | ceremony-open only, returns `{status: "ceremony_opened", location}` |
| `ceremonies.capture_read` | — | excluded — captured material is vault-class | excluded, same |

**A ceremony is never agent-triggerable.** An MCP tool that could start a
registration is an MCP tool that can create credentials on somebody's account
at a third party, on the strength of a model's judgement about whether they
wanted one. Opening the ceremony surface for a human to act on is the whole of
what an agent surface gets.

## Alternatives considered

**Better docs and a copy-paste wizard.** The status quo, and the thing users
drop out of. Retained as the fallback whenever no tier resolves — a ceremony
that cannot run must leave the user exactly the instructions they have today,
not a dead end.

**Script the provider's registration form directly, including GitHub's.**
The most literal reading of the request, and rejected in §1. It is more fragile
than the manifest endpoint, it discards a supported path, and it would put an
agent in a consent screen that exists to be read by a person.

**Ask providers for partner integrations.** Correct where it is available and
not a mechanism we can build. C0 is the general form of it: where a provider
publishes a registration flow, use it.

**Run ceremonies in the remote sandbox, as rotation does.** Rejected in §4.
It would require handing the sandbox the user's provider credentials to
establish a session the user's own browser already has, which is strictly more
exposure for strictly less capability.

**Have `OpenSesame` register one shared app for everyone.** Removes the ceremony
entirely, and is why it is tempting. Rejected: a shared app makes `OpenSesame`
the authority on every customer's repository data, which is the concentration
this product exists to avoid, and ADR 0055's BYO position already refused it for
identity providers.

## Consequences

- **Onboarding stops being where users are lost**, for the providers a recipe
  covers. The ceremony is the product's first impression, and it currently reads
  as "you must be a developer to continue".
- **A new authority is created by software on a user's account.** Rotation
  changed something that already existed; this makes something new, with
  permissions, on a third party. §5's refusals and §8's receipt are what keep
  that answerable, and both are obligations that decay if nobody re-reads them.
- **`capture_credential` is the first tool in the system that moves a secret
  *toward* the vault from an untrusted page.** It is structurally sound — the
  value never enters a model context — and it is still a new path plaintext
  travels, and should be treated as security-critical.
- **The local runner is a browser extension with per-origin authority over a
  provider's site.** Time-boxed and revoked, and it is still the largest
  permission this product asks a user for; anyone widening it is widening that.
- **Recipes for onboarding are shareable in a way rotation recipes are not** —
  one per provider, useful to everyone, and reviewable in the open. That is the
  upside of §7, and it makes the corpus a genuinely collaborative artifact
  rather than a per-user cache.
- **C0 coverage will be the number that matters.** Every provider that gains a
  manifest-flow equivalent is a ceremony that stops needing a browser at all,
  and tracking that percentage is a better health metric than recipe count.
