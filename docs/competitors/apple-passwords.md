# Apple Passwords — prior art for password change on websites

> Competitive reference for OpenSesame's **web-login rotation** work
> ([ADR 0073](../adr/0073-autonomous-web-login-rotation.md)). Never brand
> marks; never imply OpenSesame ships Apple's flow, and never imply Apple
> ships ours.

**Stance: prior art / craft bar (the deterministic tiers).** Apple defined the
convention every password manager now uses to reach a site's password-change
page, and it is the right convention. What Apple does *not* do is the part that
carries all the risk, and this document exists mostly to keep that distinction
straight.

## The correction this document exists to make

**Apple does not autonomously rotate passwords.** It is a common belief inside
discussions of automated rotation, and building a design on it produces a false
sense of trodden ground.

What Apple actually ships:

1. **The Change Password URL convention.** `/.well-known/change-password`
   (RFC 8615 well-known URIs; the W3C/WICG Change Password URL specification).
   A site that publishes it declares "this is where a password is changed."
   Safari and iOS Passwords use it to send the human straight there instead of
   making them hunt through account settings.
2. **`apple/password-manager-resources`.** An openly published corpus of
   change-password URLs for sites that do not publish the well-known path,
   password composition-rule quirks, shared-credential groupings, and website
   equivalence data. Verify its license before vendoring anything — ADR 0052 §3
   permits implementing from a public specification and forbids copying source,
   and ADR 0048 §9 records why license provenance is checked rather than
   assumed here.
3. **Security recommendations.** Detection of weak, reused, and
   breach-appearing passwords, surfaced as a list, each item deep-linked to its
   change-password page.
4. **Automatic passkey upgrade.** Where a relying party supports it, Apple will
   offer to replace the password with a passkey — credential *removal*, not
   rotation.

The human performs every password change. Apple navigates, and generates a
compliant replacement, and offers to save it. It does not fill the old password,
submit the form, or verify the result.

| Dimension | Apple Passwords | OpenSesame (ADR 0073) |
|-----------|-----------------|-----------------------|
| Finds the change page | `/.well-known/change-password` + curated corpus | same convention, same derivation |
| Generates a compliant password | yes, from composition quirks | yes, from recipe `composition` |
| Fills and submits the form | **no — the human does** | T3 deterministic replay, T4 agentic |
| Verifies the change took effect | no | fresh login, before the old value is released |
| Runs unattended on a schedule | no | T0–T3 by default |
| Recovers from a site redesign | n/a — the human adapts | teaching session → new signed recipe |
| Passkey migration | offered where supported | T0, ranked above rotation |

## What we take

**The well-known convention, unchanged.** It needs no corpus and no lookup:
`https://{host}/.well-known/change-password` is derivable, which matters because
ADR 0052 §12's rule is that a runtime capability lookup is itself a disclosure —
it tells whoever answers which sites a user holds accounts on.

**Composition rules as data.** A generator that emits a 40-character password
for a site that truncates at 16 produces a rotation that appears to succeed and
fails at next login. Apple's quirks corpus is the proof that this data is
necessary and that it has to be curated rather than inferred.

**Passkey-first.** Apple ranks passkey upgrade above password hygiene, and so
does ADR 0073: on a passkey-capable relying party, enrol-and-retire removes the
credential instead of refreshing it, and no plaintext exists during the ceremony.

**Deep-linking as the honest floor.** When nothing else works, sending the human
to the right page with a generated password ready is a real feature, not a
failure. It is T5's notification.

## What we add, and where the risk lives

T4 — a model driving a remote browser through the change flow — has no Apple
counterpart. Neither does the teaching session that repairs a broken flow, nor
unattended scheduling, nor verification by fresh login.

Two consequences worth stating in one place:

- Product copy must not imply Apple parity for the autonomous tiers. The
  phrasings to grep for are "like Apple" and "automatic password change". T3
  and T5 match Safari's behaviour; T4 does not.
- Apple's design avoids the entire class of risk in ADR 0073 §7 by never
  logging in on the user's behalf. That is a real advantage of the simpler
  design, and the reason T4 is gated, attested-only, and off by default while
  the Apple-shaped tiers are on.

## Adjacent implementations

**1Password Watchtower** and **Dashlane** both surface weak/reused/breached
credentials and deep-link to change pages via the same well-known convention.
Dashlane historically shipped a bulk "Password Changer" that automated changes
on a curated site list; its retirement is the most useful available evidence
about this category — per-site scripted automation is expensive to maintain and
degrades silently as sites change, which is precisely the objection ADR 0052 §11
raised and the reason ADR 0073 answers it with teaching sessions and drift
detection rather than with a hand-maintained script list.

**Google Password Manager** offers an in-Chrome "change password" affordance
using the same well-known path, with the human completing the flow.

The pattern across all of them: the industry converged on *navigate and
generate*, and stopped short of *fill and submit*. That is the line ADR 0073
crosses deliberately, under constraints, with the failure made loud.
