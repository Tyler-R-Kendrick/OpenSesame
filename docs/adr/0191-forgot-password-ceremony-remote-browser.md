# ADR 0191 — Forgot-password ceremony: a value-blind reset through a remote browser

- **Status:** Proposed (design only; nothing in this ADR is built)
- **Date:** 2026-10-11
- **Amends (proposed):** [ADR 0076](0076-autonomous-web-login-rotation.md) §3 constraint 6 and §7 — a third class of sandbox, chosen and paid for by the person (§9 below). Nothing else in 0076 changes.
- **Builds on:** [ADR 0005](0005-authority-handle-connectionref.md) (a caller holds a reference, never the value), [ADR 0065](0065-agent-surface-parity.md) (agent-surface parity), [ADR 0076](0076-autonomous-web-login-rotation.md) (the ladder, the tool boundary, custody before submit), [ADR 0081](0081-live-session-observation.md) (one holder of the page, a control lease), [ADR 0083](0083-browser-plane-inference-fallback.md) (the model plane), [ADR 0086](0086-wallet-native-interaction-layer.md) (an approval means what its digest says), [ADR 0130](0130-operator-controlled-capability-composition.md) (optional capabilities, consent), [ADR 0138](0138-self-issued-identity-one-native-host.md) (one native binary, roles as subcommands), [ADR 0139](0139-one-definition-every-target.md) (one definition, every target), [ADR 0149](0149-nothing-stored-in-the-clear.md), [ADR 0157](0157-logs-and-events-carry-no-secrets.md), [ADR 0158](0158-settings-rows-act-or-are-absent.md), [ADR 0159](0159-agent-hooks-interceptor.md) (hooked transport, pinned authority, closed verbs), [ADR 0190](0190-password-reset-mailboxes-are-vault-items.md) (mailboxes are vault items)
- **Design:** [Forgot-password ceremony](../architecture/forgot-password-ceremony.md) — the state machine, the verbs, the provider contract, the recipe addition and the test plan.

## Context

[ADR 0190](0190-password-reset-mailboxes-are-vault-items.md) gave a login a
mailbox and the app a way to read it, and recorded what it does not do: nothing
in the repository resets a *forgotten* password. The Host's web-login runner
replays a **change** of password for a person who is logged in
(`run_change_password_hooked`): it needs the current password, and its fixed
ordering has no step that requests a reset, waits for mail, or follows an
emailed link. The only run starters that exist are the lifecycle scanner and an
attended route that refuses a browser grant.

A forgot-password ceremony is the missing half, and it is a different shape of
problem from a change:

- **It starts with no credential.** The site is told an identifier (usually an
  email address) and answers by email. What the run needs is the identifier,
  the ability to read one mailbox, and the ability to type a new password. It
  does *not* need the current password, which is the one secret the change
  ceremony cannot do without. That is a smaller custody footprint, not a larger
  one.
- **It has an inbound secret.** The emailed link (or code) is a bearer
  capability to take over the account. It has to travel from a mailbox to a
  browser without passing through a model, the Host, a log or a record.
- **Pages differ wildly.** A change-password form sits at a well-known URL; a
  "forgot password" entry is a link somewhere on a login page, its flow varies,
  and its result pages are prose. A signed recipe per site is the end state
  (ADR 0076 §4), but the first run on a site needs something that can read a
  page. That is the case for a model in the loop, on the far side of the tool
  boundary.

The request that motivates this ADR adds two requirements:

1. The ceremony should run in a **cloud browser** — Cloudflare's Browser Run is
   the example — when the person enables that capability and has credits to
   spend on it.
2. It should work with **any browser an agent can control over CDP or an MCP
   connection**, not one vendor's.

(1) collides with a rule this repository wrote down on purpose. ADR 0076 §3
constraint 6 says T4 sandboxes are "attested and either OpenSesame-operated or
self-hosted. Never an arbitrary third-party browser service." The reason is
real: a remote browser is trusted with the *session* unavoidably (§7), and for
a reset it is also the thing that **types the new password and holds the reset
link**. §9 below does not wave that away. It splits "third-party browser" into
a kind that is still refused and a kind a person may choose, with the cost of
choosing it stated where they choose.

## Decision

### 1. A new run kind: `ForgotPassword`

Beside `ChangePassword`, with its own fixed ordering (`run_forgot_password`) and
the same discipline: every agent-facing verb hooked and its authority pinned
(ADR 0159 §10), custody steps not hooked, the critical span between the
candidate assertion and the submit never interrupted. This ADR's original rule
that runs are never resumed after a crash (ADR 0159 §15) is amended by
[ADR 0213](0213-cua-password-reset-recipes.md) only around a local durable
intent/outcome journal: completed checkpoints are reused, safe idempotent steps
may resume, and an uncertain submit goes to reconciliation rather than replay.
Unjournalized runs keep the original no-resume rule.

The ordering, in the order it must run:

1. open the site's recovery entry (a recipe's URL, the site's well-known
   change-password URL, or a page the planner located);
2. fill the **identifier by reference** and submit the request — the time of
   this submit is `T0`;
3. wait, bounded, for a message that arrived **after T0** (§4);
4. open the link the message carried, by handle, after an origin check (§4);
5. generate the candidate, **seal it and wait for its backup to be
   acknowledged** — still before anything is typed (ADR 0076 §3.2);
6. fill the new password and its confirmation, assert both hold a real value
   (fail closed, ADR 0076 §3.3), submit;
7. prove it with a fresh login in a clean context; promote; close.

Anything indeterminate after step 6 parks as `ReconciliationRequired` with the
candidate retained. Because the candidate is backed up before step 6, the worst
outcome of a failed run is the status quo (the person still has to recover the
account by hand), never a lockout that the run created. `crates/rotation` gains
no state (ADR 0076 §9); the web-login semantics stay in the policy layer.

### 2. Five new verbs, one new supertrait

The eight `BrowserTransport` verbs stay eight (ADR 0076 fixed that size on
purpose). A sibling trait, `ResetTransport`, in the way `CeremonyTransport`
sits beside it, carries what a reset adds:

| Verb | What it does | What comes back |
|---|---|---|
| `fill_identifier(ref, selector)` | types the account's identifier, resolved by the driver | `filled` |
| `follow(selector)` | activates a link or button that navigates, never inside a credential form | `navigated`, with whether the new origin is allowed |
| `await_mail(matcher, deadline)` | waits for one message after `T0` that the pinned matcher accepts | `arrived(handle)`, `absent` or `timeout` — a verdict, never content |
| `open_mail_link(handle)` | navigates to the link the message carried | `navigated`, with whether the origin is allowed |
| `enter_mail_code(handle, selector)` | for sites that email a code instead of a link | `filled` |

`MailHandle` is an opaque, run-scoped name the driver minted. **No verb returns
a link, a code, an address, a subject or a body**, in the same structural sense
as ADR 0076 §1: the tool that would read one does not exist, so no check has to
deny it. `fill_identifier` and `await_mail` take references the driver
resolves; the model and the Host see names.

Each verb's argument type implements `Authority` (ADR 0159 §10), so a new verb
cannot be added without saying what is pinned: the identifier reference, the
mailbox reference, the matcher and the origin set are pinned; a selector may
still be rewritten within the frame.

### 3. The driver is not the browser

The most consequential decision here, and the one that makes "any browser"
possible. Three parties are easy to conflate:

| Party | What it is | What it holds |
|---|---|---|
| **Driver** | the process that claims the run's steps and executes them | the identifier, the mailbox login, the candidate, the provider's token — in memory, for the run |
| **Browser** | the page the steps act on | whatever the site and the driver put in it |
| **Planner** | the model, when one is used | redacted pages and verdicts only |

Today the driver is the person's own browser extension and the browser is its
tab (ADR 0159 §16). A remote browser needs a driver that is **not** the
browser, for two reasons that are independent of any vendor: Cloudflare's CDP
endpoint authenticates with an `Authorization: Bearer` header, which a page or
an extension service worker cannot put on a WebSocket, and the provider's token
must never be in a page. So:

- The remote-browser driver is a **new role of the one native binary**
  (`opensesame driver run`, ADR 0138), on a machine the person controls — a
  laptop, a home server, a container. It claims the same steps from the same
  queue the extension does, with the owner's native session, and answers the
  same closed outcomes. The Host's runner, hook records, settle route and
  reaper are unchanged; **which kind of runner claims the steps** is the only new
  fact (implementation must find where the claim route and the run record keep
  it: today they list runs by credential ownership and a browser grant).
- It is **not** the Host (which is value-blind by design: it holds hook records
  of verb names, not values), **not** the daemon (its dependency budget,
  `pnpm audit:daemon-deps`, forbids a WebSocket, TLS and mail stack, and
  `crates/rotation-web` is not a daemon dependency), and **not** a cloud worker
  (that would put the secrets with a second third party, beside the browser's).
- It is given only what a forgot-run needs, per origin, in a **delegation**
  the person's vault seals to the driver's public key: the identifier, the
  mailbox (an `email-account` item's connection, or a `ConnectionRef` to a
  Gmail or Graph connection with its read-only mail scope), and the provider the
  person approved for that origin. It never receives the vault key or any other
  item. A delegation has a TTL and is revocable.

### 4. The mailbox is read by the driver, read-only, and the link is checked before it is opened

- **Read-only is the rule, not a preference.** The driver reads with read-only
  access: IMAP `EXAMINE`, JMAP without write scopes, the `gmail.readonly` and
  `Mail.Read` scopes the connector catalog already lists. It never deletes,
  moves, flags or marks mail, so the site's own "your password was changed"
  notice still reaches the person, and a stolen driver cannot hide a takeover.
  A native driver also lifts ADR 0190's JMAP-only limit: IMAP and POP3 are
  readable here.
- **Only mail after `T0`, from the expected sender, once.** `await_mail`
  accepts a message that arrived after the request, within a window, matching a
  pinned matcher (sender domains, subject hints, the link's host and path
  shape). The first acceptable message wins; a second is ignored. A reset
  message nobody asked for is **never acted on**: ADR 0190's scan only
  announces it, and a run starts only from a person's approval (§8).
- **The link is a bearer capability and is treated as one.** `open_mail_link`
  refuses unless the link is `https`, carries no userinfo, and its origin is in
  the run's allowed set (the site's own origins, plus any link-tracking hosts a
  recipe names). A link to anywhere else — the phishing shape, or a tracking
  redirector nobody reviewed — parks the run with a fixed reason, and the
  person is told. The link is held in memory, used once and dropped; it is in
  no record, log, notice or outcome.

### 5. The browser is a provider behind a contract; CDP and MCP are two ways to meet it

A **browser provider** is data (`spec/browser-providers/<id>.json`, consumed by
both planes with a drift test in each, ADR 0139) and an adapter that meets one
contract: open an *ephemeral, isolated* browser, drive it with the eight plus
five verbs above, confine it to an origin set, report what it can enforce, meter
its time, close it. The contract does not name Cloudflare, Chrome or a protocol.

- **`cdp` providers** speak the Chrome DevTools Protocol over a WebSocket. The
  driver is the CDP client: it types with `Input.insertText` (ADR 0076 §1), reads
  a redacted tree with `Accessibility.getFullAXTree`, and, where the provider
  does not enforce an origin set itself, enforces one with `Fetch` request
  interception and navigation events. Cloudflare Browser Run, a self-hosted
  headless Chrome and any other CDP endpoint are this kind.
- **`mcp` providers** are MCP servers that expose a browser as tools
  (Chrome DevTools MCP, Playwright MCP, a vendor's). **OpenSesame is their
  client**: the driver maps its closed verbs onto the server's tools through the
  provider profile, and the planner is *never handed the server's tools*. That
  is what keeps ADR 0076's tool boundary intact over an arbitrary provider. The
  profile carries a tool **allow-list**; the arbitrary-script tools
  (`browser_evaluate`, `browser_run_code_unsafe`, `evaluate_script`) are not on
  it.
- **Each provider declares what it can promise**, and the run reads it:
  - *confinement* — `enforced` (the provider refuses off-origin requests;
    Cloudflare's guardrails do) or `attested` (the driver checks URLs after the
    fact; the MCP servers' own origin options are, by their docs, not a security
    boundary and do not cover redirects);
  - *custody* — what the provider can observe: always `input`, since the
    provider types the password;
  - *recording* — must be provably off;
  - *handoff* — whether a person can take the page (§7).

  A provider is selectable only after it passes a **conformance suite** against
  a fixture site and a mail catcher on loopback. No suite, no provider.

### 6. The model plans; it never holds a value, and it is optional

A planner (any agent runtime that can call a run-scoped tool surface; ADR 0076
§8 keeps an LLM dependency out of every shipped binary) is used **only where a
site is unknown**: to find the recovery entry, to name the identifier field and
the request button, to read what the result page says, to find the new-password
fields and any composition rules. It sees `read_dom_redacted` and
`screenshot_redacted`, with the identifier and every credential field stripped
at capture, and it returns **selectors**, which the driver validates (they must
resolve to exactly one element of the expected type, inside the site's origin
frame) before anything is executed. It never sees mail.

The deterministic spine of §1 does not need a planner. After a run that
succeeds, the driver emits a **candidate `forgot_password` recipe section** —
selectors, expectations and the mail matcher, no value, the same for every user
of the site — which is canary-verified and signed like any recipe (ADR 0076
§4). The next run on that site is deterministic and costs no model call: the
expensive tier is a bootstrap for the cheap one.

### 7. A challenge is a stop, handed to the person, never solved

ADR 0076 §3.4 stands in full. A CAPTCHA, a "verify you are human" page or an
unexpected second factor parks the run. Where the provider supports it, the
person takes the page: Cloudflare's Live View and its human-handoff commands
(`Cloudflare.handoff`, `Cloudflare.handoffComplete`) map onto ADR 0081's
control lease, and the lease expiring parks the run rather than resuming
autonomy. No solver, no fingerprint impersonation, no residential egress.

### 8. Consent, approval and credits

- **A capability of its own.** `agents.remote-browser` (optional, default off)
  holds the providers a person has configured; `ai.password-reset` (ADR 0190)
  gains the action that starts a run. Each provider's credential is a
  `ConnectionRef` (the connector catalog's `cloudflare` row already names
  `api.cloudflare.com` and the token verify path; the browser operations are
  added to that row, not to a copy of it). A provider declares its egress the
  way every capability does; `automatic` is **false**: nothing reaches a
  provider unless a person approved a run.
- **Each run is approved by a person**, as an Interaction (ADR 0086) whose
  digest covers the site, the mailbox, the provider, its custody class and the
  most browser time it may use. A standing approval for a site, for unattended
  runs, is a later phase and needs the step-up the policy replace route already
  needs (ADR 0159 §12). An agent surface cannot start, approve or read a run.
- **Credits are the person's own, and OpenSesame meters them locally.** There is
  no documented usage or balance API for Cloudflare's product: usage is shown in
  its dashboard, tracked per day in seconds and billed per browser hour (at the
  time of writing, ten hours a month included on the paid plan, then $0.09 an
  hour; ten minutes a day and three browsers on the free plan). So the budget is
  a **local, conservative ledger** with the reserve → commit → release shape the
  wallet journal already has: a per-run cap, a monthly cap the person sets, the
  reservation taken at approval and the actual taken at close. A provider that
  answers "limit reached" is `unavailable(quota)`; the run is **not retried and
  not moved to another provider**, because another provider has another custody
  class. The panel says what was used, counted by OpenSesame, and that the
  provider's dashboard is the record.
- **A run costs little by design.** A reset is two short interactions with a long
  wait between them, so the default **session shape** is two sessions: request
  the reset, close the browser, wait for the mail with the provider idle and
  unbilled, then open a new session for the link and the form. A site that binds
  the token to the browser that asked (the recipe says so) takes one session
  held open with a heartbeat instead.
- **Agent surfaces.** Per ADR 0065, every operation introduced here is a registry
  entry and is excluded from `mcp_host`, `mcp_client` and `webmcp` citing this
  ADR: a surface an agent could drive would let it spend a person's credits and
  reset their accounts. The planner's tool surface is **per run**, short-lived
  and minted by an approved launch handle (ADR 0099); it is not a surface in the
  registry's sense and exposes only the verdict-only verbs of §2.

### 9. The amendment: sandbox classes, and what a chosen provider can and cannot be

ADR 0076 §3.6 and threat-model S1 are amended as follows. A sandbox is one of:

| Class | Who runs it | Allowed |
|---|---|---|
| **A** | OpenSesame | as today (none exists) |
| **B** | the person or their operator — a browser on a machine they control, reached by CDP | as today |
| **C** | a hosted provider **the person named and pays for, on their own account** | only under the conditions below |

A is not what a person typically has; B is the privacy-preserving choice and
the one the docs recommend; C is the convenience this ADR adds. Class C is
allowed only when **all** of these hold:

1. **Off by default, per provider and per site.** The capability is off until
   chosen, and a site needs its own opt-in (ADR 0076 §2's per-domain rule).
2. **Consent says what the provider can see**, in the sheet that adds it: the
   page, the reset link, the identifier and the new password as it is typed.
   And what it cannot: the vault, any other item, the mailbox login. The
   consent is a `ConsentReceipt` (ADR 0130) bound to the provider id and the
   custody class; a change of either asks again.
3. **Confinement is enforced where the provider can, attested where it cannot,
   and the receipt says which.** Cloudflare's guardrails take up to fifty
   hostnames, are fixed for a session's life and answer an off-list request with
   a 403; they are set at session creation. Page dependencies must be on the list
   too, so the first run on a site needs the site's asset hosts (a recipe names
   them; the first run starts from the site's own registrable domain and the
   provider's CDN set, widening only with the person's approval).
4. **Recording off, proved.** Recording is opt-in on Cloudflare and only settable
   at session creation; the adapter never sets it and the conformance suite fails
   a provider that returns one. Where a provider records, the class-C run is
   refused.
5. **No integrity claim.** The driver cannot verify what a hostile provider
   tells it: a browser that lies "present" defeats the presence assertion, and
   one that lies "logged in" defeats `verify_login`. A class-C run therefore
   claims *confidentiality against the planner and the Host*, never *integrity
   against the provider*, and S1 is stronger than for A or B: the provider holds
   the session and the new password both. Product copy never says "secure
   sandbox" or "attested" for class C; the phrase to grep for is "attested".
6. **Never an automatic fallback.** A run never moves from B to C, or from one
   C provider to another, because the custody changes. A person chooses.
7. **An organization can forbid it.** Policy gains `allowed_sandbox_classes`; the
   default for a managed account is A and B only.

The residual risks are written next to S1 in the threat model, not argued away.

### 10. Safety rules that belong to a reset

- **One request per site per cooldown, and a daily cap.** A forgot-password
  request is an email to a person; the ceremony must not be a way to send
  someone a hundred.
- **The run starts only from a person.** Mail that arrives unasked is announced
  (ADR 0190), never acted on.
- **The mailbox is bound by the delegation, not by the run.** A run may read only
  the mailbox its delegation names, only for its own origin's matcher.
- **The reset link, the code and the candidate are in no log, record, notice,
  receipt or outcome** (ADR 0157). Property tests plant canary strings and
  assert they appear nowhere (architecture §8).
- **Hostile pages and hostile mail are the baseline.** Page text reaches a
  planner as inert quoted data (`UntrustedText`); the model never receives mail;
  a selector it proposes is validated, not trusted.

## What is deliberately not decided here

Four things need a person's judgement and are written as questions in the design
document rather than guessed at here: **where the new password lands in the
person's vault** (the shipped change ceremony stops at a driver-held store and a
backup; a forgot ceremony makes the gap matter more), **who plans** (a tab, the
person's own agent over MCP, or a worker with a model endpoint), **how a person
with no native binary is served** (the design says no cloud driver in v1), and
**the exact Cloudflare behaviours the documentation leaves open** (the header or
parameter that sets guardrails on a CDP acquire, the `keep_alive` maximum, which
CDP domains are available). Each has a spike in the plan.

## Alternatives considered

**The Host drives the browser.** The Host already runs the runner and holds the
hook records, and a Host-side CDP client would be the least new code. Rejected
because the Host would then hold the new password and the reset link. It is
value-blind on purpose (it persists verb names and verdicts), and the human vault
is end-to-end encrypted, so the Host never holds the passwords in a person's
vault; this would make a reset the one place it does.

**The extension drives a remote browser.** It keeps the existing driver. Rejected
for the remote case: a page and an MV3 service worker cannot set the
`Authorization` header Cloudflare's WebSocket requires, putting the provider's
token in a URL or a header-rewriting rule is a secret in the wrong place, and a
service worker's lifetime is a poor fit for a run with a wait in the middle. The
extension remains the driver for the person's own tab.

**A hosted driver in a Worker.** It would serve a person with no native binary.
Rejected for v1 because the secrets would be with a second third party, and the
ADR-0076-§7 residual would apply to both. A later, separately-consented option.

**Let any agent drive the browser MCP directly, with a proxy that substitutes
credential references.** The most general reading of "any CDP MCP connection".
Rejected on ADR 0076 §6's grounds, which apply in full: the page generates the
request, so the placeholder becomes the authorization; a page that hashes or
encrypts the field before the wire submits the placeholder as the new password;
and the browser tools return DOM and values the agent should not see. The
accepted shape reaches the same breadth the other way round: **OpenSesame is the
client of any provider, and the agent is the client of OpenSesame's closed
verbs.**

**Use the site's email-OTP login instead of a reset.** Not a reset: it logs in
and leaves the forgotten password forgotten. Where a site offers passkeys, ADR
0076's T0 (enrol and retire) outranks both and a reset run should offer it in a
later phase.

## Consequences

- **A forgotten password becomes recoverable on a site the person never taught,**
  once a planner exists, and cheaper on every later run because the first leaves
  a signed recipe.
- **A mailbox login is now an account-takeover key for every site its address
  resets.** That was true of ADR 0190's reader; a driver that holds it, and a
  provider that sees the reset link, widen it. The controls are scope (read-only,
  per-origin, per-delegation), approval (a person per run), and the absence of
  any value on any record. They reduce the risk; they do not remove it.
- **Class C trades custody for convenience, openly.** A person who picks a hosted
  browser accepts that its operator could capture the new password. The product's
  job is to say so where they pick it and to offer class B first.
- **The reachable set of sites is bounded by provider limits and by challenges.**
  A datacenter browser is close to the signature bot defences are built to stop
  (threat model S4). This design does not try to defeat them; a blocked run is a
  handoff to the person.
- **It adds a role to the native binary and a spec family** (`spec/browser-providers/`),
  both with drift tests; it adds no state to `crates/rotation` and no new Host
  transport.
- **Credits are real money the product does not hold.** The budget is a local
  estimate against an account OpenSesame cannot read; the copy must not imply
  otherwise.

## Plan

Phases and their gates are in the [design document](../architecture/forgot-password-ceremony.md#9-phases-and-gates);
the order is: provider and conformance spikes, the verbs and the deterministic
spine against a fixture site, the mail reader, the native driver and delegation,
the class-C consent and the budget, then the planner and recipe distillation, and
last standing approvals. Phase 0 can start without this ADR being accepted; no
other phase can.
