# Rotation teaching sessions and replay

What happens when the agent cannot finish a password change, and how that
failure turns into a deterministic recipe instead of a dead end.

Decision record: [ADR 0076 §4](../adr/0076-autonomous-web-login-rotation.md).
Overall flow: [web-login rotation](web-login-rotation.md).
Output format: [rotation recipe schema](rotation-recipe-schema.md).
While it runs: [live session observation](live-session-observation.md).

## Why this exists

ADR 0052 §11 refused programmatic third-party password change with a specific
objection, and it was the right objection:

> there is no way to make a third party's account settings page programmatic,
> and pretending otherwise ships a feature that fails silently.

The problem named there is not *failure*. It is *silence*. A rotation feature
that quietly stops working when a site redesigns is worse than no feature,
because the user believes their passwords are rotating and they are not.

Teaching sessions are the answer to that sentence. A blocked run is loud: it
notifies, it parks, it hands the user a replay of exactly where it went wrong,
and it asks them to show it the way through once. What the user demonstrates
becomes a signed recipe, and the next run on that domain is deterministic.

The ladder in ADR 0076 §2 makes this the economic engine of the whole design:
the expensive non-deterministic tier (T4) exists to bootstrap the cheap
deterministic one (T3). A site that needs an agent once needs a recipe replay
afterwards.

## The loop

```
run blocks
   |
   v
notify user: what was attempted, where it stopped
   |
   v
replay overlay: scrub the recorded run, see the failure in context
   |
   v
user attaches to the SAME sandbox and demonstrates the way through
   |
   v
capture, value-blind: selectors, events, navigation, waits, credential refs
   |
   v
canary-verify, sign
   |
   v
future runs on this domain resolve to T3 (deterministic)
```

## Blockers worth a teaching session

| Blocker | Why an agent stalls | What a human demonstrates |
|---|---|---|
| Unknown layout | no recipe, DOM does not match any known shape | which field is which, what order |
| Recipe drift | site redesigned, selectors miss | the new selectors, by using them |
| Unexpected step-up | email code, SMS, authenticator prompt mid-flow | where the code goes, what the flow looks like after |
| Multi-page flow | change is behind two settings pages and a re-auth | the navigation path |
| Confirmation ambiguity | submitted, no clear success signal | what success actually looks like on this site |

**CAPTCHA is not on this list.** ADR 0076 constraint 4 forbids solving one or
evading detection. A CAPTCHA parks the job and notifies; the user may complete
it themselves in the attached session, and what gets recorded is the surrounding
flow, never an attempt to defeat the challenge.

## The replay overlay

Every run is recorded, not only failing ones. The overlay renders the recording
as a scrubbable timeline where each agent action sits beside the page state it
acted on.

Replay and the live view are the same reader over the same log: replay seeks,
live tails (ADR 0078 §1). There is no separate low-latency capture path, because
a second path is where a redaction step gets skipped.

What it shows per step:

- the action the agent took, and the tool it called
- the page state at that moment (redacted DOM snapshot, masked screenshot)
- the agent's stated reason for the step
- the outcome, and for the terminal step, the blocker

What it must never show: a credential value, in any field, in any frame. That
property does not come from the overlay — it comes from capture (below). An
overlay that filters at render time would mean the unredacted form exists
somewhere, which is the thing being prevented.

Recording every run, not just failures, buys three things: receipts get evidence
a human can actually check, recipe drift becomes visible before it becomes a
failure, and a user who is asked to trust an automated password change can see
what was done on their behalf.

## Demonstration happens in the sandbox

The user attaches interactively to the **same sandbox instance** — view and
control — rather than demonstrating in their own browser. Who may attach, how
control changes hands, and why a lease that expires parks the run instead of
returning it to the agent are [ADR 0078](../adr/0078-live-session-observation.md)'s
subject; a demonstration is one use of a channel that is open for the whole run.

This is a requirement, not a convenience. The agent will replay in that
environment. A demonstration recorded against a different browser, a different
DOM, a different viewport and a different network position teaches a lesson
that does not transfer, and produces a recipe that fails on first replay. The
whole point of the teaching session is that what the user shows is what the
agent will do.

The trade is that the sandbox's session and network position are what the user
is operating through during the demonstration. ADR 0076 §7's residual risk
applies to teaching sessions exactly as it applies to runs, and the same
mitigations hold: attested sandboxes, post-run account-security diff,
sign-out-everywhere at the end.

## Capture is value-blind by construction

The recorder cannot capture a typed secret. Not "does not" — cannot, in the
same structural sense as `crates/connection-detect`'s `CommandRunner`, whose
contract returns an exit status so raw output has no path out.

Captured:

- selectors and a stable element fingerprint (role, label, name, position)
- the event sequence: focus, input, click, key, navigation, wait
- navigation graph and the URLs visited
- waits and the conditions that satisfied them
- **credential-field references** — that a secret went here, never which one or
  what it was

Never captured:

- the value of any `input[type=password]`
- the value of any field the user marks as sensitive during the session
- the value of any field a live candidate handle was written to
- clipboard contents
- unmasked pixels over a credential field

Two rules keep this from decaying:

**Capture-time, not render-time.** Values are dropped in the capture pipeline
before a recording frame exists. There is no unredacted recording that gets
filtered on the way out.

**Fail-closed on unknown fields.** A field the recorder cannot classify is
treated as sensitive and its value dropped. The cost is an occasional recipe
that needs the user to re-mark a field as non-secret. The alternative cost is a
password in a recording.

One-time codes deserve a specific note: a TOTP or emailed code typed during a
demonstration is a secret at capture time and worthless a minute later, but it
is still captured as a reference, never a value. Recipes record *that a step-up
code goes here*, so a later run can request one — they never record the digits.

## Recordings are vault-class data

A recording with zero passwords in it still contains an authenticated view of
someone's account: balances, addresses, message subjects, security settings.
Treat it accordingly.

- sealed at rest, under the same envelope discipline as vault items
- TTL-bound; default retention is the observation window, not forever
- excluded from every agent surface (ADR 0076 §10)
- never returned by a job-listing API; fetched only through an explicit human
  ceremony
- deleted with the job, and on user request

This is a genuine increase in blast radius and is recorded as such in ADR 0076's
consequences. The feature did not exist before; now the gateway stores
authenticated views of people's accounts.

## From demonstration to recipe

A demonstration produces a **candidate** recipe, never a trusted one.

1. **Generalize.** Selectors are lifted from the exact captured node toward a
   stable fingerprint, so the recipe survives a class-name change.
2. **Canary-verify.** The recipe is replayed against a real change to a value
   we hold, and verified by fresh login. A recipe that has never completed a
   round trip is not signed. This is the only sound proof — a static read of
   the page cannot tell you whether the flow works.
3. **Sign and bind.** The signed recipe carries an expiry and a binding to the
   site's JS bundle hash, so drift is detected rather than discovered.
4. **Promote.** Subsequent runs on the domain resolve to T3.

A recipe that fails replay does not silently fall back to T4 forever: repeated
failure re-enters the teaching loop and notifies, so a site that has genuinely
become un-rotatable says so.

## Sharing, and what is not shared

A recipe is structure — selectors, an event order, a navigation path. It
contains no account data and no secret, so it is shareable in principle, and
sharing is what makes the corpus cover the long tail rather than one user's
sites.

Nothing is shared by default. Any corpus contribution is an explicit ceremony,
reviewed on the same terms as the checked-in relying-party data in ADR 0052
§12, and a recording is never shared — only the derived recipe. The
distinction matters: the recipe is structure, the recording is someone's
account.
