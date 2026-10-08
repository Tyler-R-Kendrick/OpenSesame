# Controls — icon keys, and which glyph

Read [`DESIGN.md`](../../DESIGN.md) before drawing a control. An action that
executes is an icon key. A word on a button face is a design failure.
`scripts/quality/design-lint.mjs` (`pnpm lint:design`) and `impeccable detect` hold
new code to that, and both run in `.githooks/pre-commit`.

## Native dropdowns

Keep native selection and keyboard behavior. Popup options and groups pair
opaque `--surface` backgrounds with `--ink` text in `native-controls.css`;
the root color scheme follows the selected theme, including system mode.
Never hard-code white/black dropdown colors. `pnpm lint:design` checks both
the shared popup pair and component overrides; browser checks cover contrast.
A connector panel head is a title. `pnpm lint:design` rejects a hint caption
under it, and rejects explainer sentences that describe the panel instead of
showing the account, grant, or repository. An in-page `note` or `conn-flash`
box is rejected the same way: a failure is a `StatusMark`, never a paragraph.
Pages copy never names a Host, and a browser-local action never tells the
person to pair one.

## 0. Explainer prose and in-page errors are both failures

Two things a screen must not carry, because both are text about the screen
rather than the thing the person came for:

**Explainer prose.** A sentence that narrates what a panel is, why it is in the
state it is in, or what the device can and cannot do. "This browser has no
on-device model, and this deployment has no support endpoint configured." "No
repositories returned." "Nothing has reported yet." The screen already shows
its state — the rows, the fields, the `StatusMark`, the control that acts on
it — and a sentence restating that state is a caption on a picture the person
is already looking at. Where a state genuinely changes what the person can do,
show the control that changes it (`Download the on-device model`) and name it
as its own accessible name; the control is the explanation. Where it does not,
say nothing.

The one exception is a sentence that is itself the content: the answer support
returns, the prose of a help topic, the `say` line a walkthrough speaks while
it points at something. That is not explainer prose, it is the thing asked for.

**In-page error boxes.** A `note--err` paragraph banner, a dynamic
`note--${tone}`, a `*__error` paragraph, a `broker__card--err` card, a visible
`role="alert"`, or any block filled with the error wash, rendered inside a
screen. A failure belongs on the object that failed — a `StatusMark` beside
the row, the field, the receipt — and, because a 14px glyph's label is read by
nobody, as a notice in the tray: `<FailureNotice id title message />`
(`apps/pages/src/components/FailureNotice.tsx`), `useFailureNotice`
(`apps/pages/src/components/use-failure-notice.ts`) or `StatusNote`, all of which end
in `setStatusNotice`. The tray already carries every other page condition,
announces an error with `role="alert"`, and survives the screen that produced
it being navigated away from. The tray can offer a retry, but only when the
caller supplies one through `setStatusNotice` (`retry` / `retryLabel`); the
three seam components (`FailureNotice`, `useFailureNotice`, `StatusNote`) do
not pass one. An error box in the middle
of a screen is explainer prose wearing an alert role: it interrupts the whole
screen to narrate one failed thing, and it is gone the moment the person moves.

A screen with no shell — unlock, the front door, the federated return, an
unframed popup — has no bell of its own, so `AppRoot` mounts `NoticeCorner`
there; it draws only while the tray holds something
([ADR 0163](../adr/0163-failures-live-in-the-tray.md)).

What is a failure is drawn by what the sentence reports: an operation that was
attempted and did not succeed goes to the tray; a disclosure, guidance or
empty-state instruction, a destructive confirmation or a live status the
person must read before acting stays in the page
([ADR 0163](../adr/0163-failures-live-in-the-tray.md)).

A notice is keyed by `id` — one per place, so a second try replaces the first
and a success clears it; give a per-item editor the item's id. A visually-hidden
live region (`className="visually-hidden" role="alert"`) is the one spelling of
`role="alert"` the lint allows: it draws nothing.

**Modal ceremonies.** A failure that arises inside an `aria-modal` ceremony
sheet cannot rely on the bell: the bell is unreachable while the sheet is open.
The sheet therefore shows the sentence as its own status line — `CeremonyShell`'s
mark and its top line — and the tray receives it too, so it is still there when
the sheet closes. The page-level rule is unchanged: no box is drawn in the page.

**Live validation is not a failure.** An unsaved draft that does not yet
validate (a malformed address, a name already taken) is not a failed operation.
It is a `StatusMark` on the field and nothing is sent to the tray; a notice is
for something that was attempted and did not work.

`pnpm lint:design` holds both. Explainer sentences are matched by content in
the connector panels, and by shape everywhere (`no-hint-caption`, rule 17).
In-page failures are a plain failure
(`no-in-page-error` for markup, `no-error-box-css` for CSS that paints one) with
no ledger: the count is zero everywhere, and a new file meets that outright.
The tray's own `.notice-card--err`, the `StatusMark` glyph and `aria-invalid`
field borders may carry the error colour; nothing else may — in particular no
control (rule 14).

## 1. The terminal commit — `.go`

**The one action that ends the screen you are on, or the ceremony card you
are in.** Unlocking a vault. Sealing a device. Finishing setup. Removing a
key, erasing this browser — `CeremonyShell` draws its primary this way. The
one irreversible act is the same square with the bin glyph (`tone: "danger"`
picks the glyph and keeps the card plain); it is not red, and there is no Keep
key beside it: the sheet's close key is the way out and where the keyboard
lands (rules 14 and 15).

```html
<div class="go-row">
  <button type="button" class="go" aria-label="Finish setup" title="Finish setup">
    <IconCheck size={18} />
  </button>
  <span class="go-verb" aria-hidden="true">Finish setup</span>
</div>
```

- An **ink square** carrying the glyph of what it does — never a text slab.
- Its sentence sits **beside** it, in the margin voice (`.go-verb`, mono,
  `--ink-2`), and is `aria-hidden` because the square already carries it as its
  accessible name. A screen reader must not hear the verb twice.
- The accessible name is required: `aria-label` (and `title`, for a pointer).
- Defined once, in `styles.css`. Never re-implemented per screen.

**Why not a wide text button.** At the bottom of a phone, a full-width slab of
prose reads as a banner rather than a control, and the verb it carries is the
one piece of text a person has already decided to act on — so setting it in the
margin voice beside a mark costs nothing and buys back the width. It is also
the only way the control stays recognisable across screens: the square is the
same object every time, and only its glyph changes.

## 2. The in-card action — `icon-btn`

**A thing to do *here*, beside the facts that justify it.** Authorizing a
connector. Revoking a grant. Copying a callback. Loading another page of rows.

```html
<div class="actions">
  <button type="button" class="icon-btn icon-btn--sm" aria-label="Revoke" title="Revoke">
    <IconTrash size={16} />
  </button>
</div>
```

- The same icon key as everywhere else. The sentence is `aria-label` and
  `title`, never visible text.
- Choice objects stay words: a provider name, a mode, a navigation target,
  the guest road. Those are not executing verbs.
- It lives inside a card or a panel body. A screen's foot is still `.go`.

## 2a. The form commit — `FormCommit`

**The key that saves a form of several fields.** Connecting a provider.
Saving a Git remote. Creating a local request. Saving an item.

```tsx
<FormCommit label="Save Git remote" disabled={!canSave}>
  <button type="button" className="icon-btn" aria-label="Cancel" title="Cancel">
    <IconX size={16} />
  </button>
</FormCommit>
```

- It is the `.go` square with its `.go-verb`, from `components/FormCommit.tsx`
  — the same object at the foot of every multi-field form.
- The form's secondary keys are its children and ride the same row.
- A one-field form does not use it: its key ends the field's row
  (`.field-inline`, or a `FieldShell` `tail`).

## Where a key lives

A key sits on the row of what it acts on, at the row's end. Never a row of
its own. See DESIGN.md § Keys have a home.

| The key acts on | Its home |
| --- | --- |
| the panel | the panel head, beside the title |
| one field | that field's label row, `.keyed-field` (keys after the field in Tab order) |
| a one-field form | the end of the field, `.field-inline` or `FieldShell` `tail` |
| a form of several fields | `FormCommit` |
| a record | the record's row, folding into a block at its top end |

## The rule in one line

> A screen's foot commits with `.go`; a form of several fields with `FormCommit`. Every other executing action is an `icon-btn` on the row of what it acts on. A status is a `StatusMark`, never a text pill.

## 3. Status — `StatusMark`

**A condition, not a name.** Connected. Needs you. Broken. Revoked. Saved.
Locked. Authorized.

```html
<span class="status-mark status-mark--ok" role="img" aria-label="Connected" title="Connected">
  <!-- IconCheck -->
</span>
```

- The glyph is an existing icon: check, alert, dismiss, or lock. Colour is the tone.
- The word is `aria-label` and `title` only.
- A provider, a role, a person, or a platform is a name. Those may stay text. A status may not.

## 4. Status copy — states the fact

**A sentence that explains itself is not a status.** A status says
what is, and stops.

- No consolation tail (`The written help below still works.`). The
  help is the panel; it does not need an advertisement.
- No walk through the browser's own settings (`enable … at
  chrome://flags`, `relaunch`, `reload this page`). How to turn a
  browser API on is the browser's documentation, not this app's
  prose — the app cannot enable a browser API itself, and saying so
  is a disclaimer, not a status.
- No apology for what cannot be turned on. `No on-device model and
  no support endpoint on this deployment.` is the fact; the tail
  that follows it is not.

The rule lives in strings as much as in JSX: the support pane's
every sentence is a string in a `.ts` module, so the lint reads
string literals — comments skipped, a `//` inside a URL string read
as the address it is — not only JSX text.

## What is enforced

`scripts/quality/design-lint.mjs`, run by `pnpm lint:design`, the `pre-commit` hook,
and a Claude Code `PostToolUse` hook:

1. **No text-labelled primary in a commit bar.** A `*__foot` element containing
   `btn--primary` is the violation this page exists for.
2. **`.go` is not re-implemented.** Only `styles.css` may define `.go`,
   `.go-row` or `.go-verb`; a second copy in a screen stylesheet is drift.
3. **Every `.go` carries an accessible name.** The glyph is not a label.
4. **Every `.go` has a `.go-verb` beside it.** An unlabelled ink square is a
   mystery-meat control.
5. **A commit key has a home** (`commit-key-has-a-home`). An icon-key
   submit sits in `.keyed-field`, `.keyed-row`, `.field-inline`, a `FieldShell` `tail`, or an
   inline one-field form. Anywhere else it is a glyph on a row of its own;
   use `FormCommit`.
6. **A field has a measure** (`field-has-a-measure`). A CSS rule that gives
   an `input`, `select` or `textarea` `width: 100%` also gives it a
   `max-width`: `var(--field-max)`, `var(--text-max)`, or `none` for an
   overlay.
7. **Vault commands are persistent icon keys.** The top path strip retains
   New item (`+`), Import, and Export in empty, filtered, and populated views.
   The trash directory replaces that group with Restore and Delete permanently.
   Each has an accessible name and tooltip. Text-button styles in
   `VaultSection` or `VaultPathbar` are a hard lint failure; render tests pin
   the commands and their location. Import opens the file picker;
   Export opens the encrypted-backup sheet, never a plaintext dump.
   The path/count status row stays at the pane bottom in empty and populated
   views; only the item area scrolls, never the command or status strip.
 8. **A status states the fact and stops** (`no-status-explainer`). A
    string that consoles (`still works`), walks the browser's own
    settings (`chrome://flags`, `relaunch`, `reload this page`), or
    disclaims what the app cannot enable (`cannot enable … itself`)
    is a failure — in a `.tsx` screen or a `.ts` module alike, since
    the copy lives in strings. Specs are not UI and are not swept.
 9. **A verb passed in a prop is still a verb on a button** (`word-slot`).
    A text button (`btn`, `btn--primary`…) whose face renders
    a prop or a variable — `{primary.label}`, `{submitLabel}` — is a slot the
    literal check cannot read, so the slot itself fails unless the button is
    a `choice`. `CeremonyShell` draws its primary as the `.go` square with
    the verb beside it and its secondary as an icon key; a key whose words
    are the thing chosen passes `choice: true`.
10. **A sheet carries no caption** (`sheet-caption`). A sheet is its mark,
    its name and its close key, then the card. A `subtitle` or `foot` prop, a
    `<p>` in a `sheet__head`, a `hint` in a `sheet__foot`, or a `setFoot`
    call is a line about the sheet rather than the sheet. What it would have
    said is a fact in the card ("Untouched: backups, other devices").
11. **An ask is not an alarm** (`ask-is-not-alarm`). A `CeremonyShell` whose
    primary is `tone: "danger"` has not failed: it passes neither
    `ok={false}` (the warning wash) nor `top` (a kicker). The card is drawn
    plain and the bin glyph, the facts and the close key carry the weight.
12. **The top line is a fact** (`top-is-a-fact`). `top` is "Enrolled",
    "7 of 10 left", "Saved" — never a question.
13. **A title is said once** (`title-said-once`). A ceremony's `name` or
    `top` that repeats its sheet's title (`<h2>`, a frame's `title`, the
    dialog's `aria-label`) names the question twice; name the object the
    ceremony acts on instead — the vault, the key, the origin.

14. **A control is never red** (`no-danger-control`, `no-control-error-ink`).
    The error ink is a status: a `StatusMark`, the tray card, an
    `aria-invalid` border. A `btn--danger`, `go--danger`, `icon-btn--danger`
    or `set__nav-link--danger` class, or a CSS rule for a control, a danger
    modifier or an armed key that reads `--err`, `--err-wash`, `--err-ink` or
    `--danger`, fails. Armed keys invert to ink; a menu entry that destroys
    is an ordinary entry. No ledger: the count is zero.
15. **A sheet has one way out** (`one-way-out`). The head's close key, Escape
    and the scrim leave a sheet. A `CeremonyShell` `secondary` whose label only
    leaves ("Keep it", "Keep them here", "Not now", "Cancel", "Back") is a
    second X beside the first and fails; the keyboard lands on the close key.
16. **Corners are square** (`no-round-corners`). `--radius` is 0. A
    `border-radius` past 0 — 2px, a pill, a circle, a percentage, a value the
    lint cannot resolve — fails, on a control, a dot, a knob or a panel alike.
    The ledger is empty.

17. **A hint is a fact, not a caption** (`no-hint-caption`). A `.hint` (or
    `*__hint`) element whose static copy runs five words or more, whose copy
    is read from a `help`, `guidance`, `reason` or `note` property, or a
    `FieldShell` given a `hint` at all, is a line about a control rather than
    a fact the screen shows. `Enrolled {date}`, `Callback: {url}` and `No
    receipts yet.` stay; "Whole hostname only, case-insensitive…" under an
    address does not. The sentence goes on the control's `aria-label` or
    `title`, or nowhere. There is no `?` key and no extra row for it. No
    ledger: the count is zero, and `FieldShell` has no `hint` prop.
    `scripts/quality/design-lint-hints.mjs` holds it and
    `apps/pages/src/screens/setup/control-contract.test.ts` watches it fail.

`scripts/quality/design-lint-sheets.mjs` holds rules 9–13 and 15, and
`apps/pages/src/screens/setup/sheet-contract.test.ts` watches each one fail
on the "Reset this browser?" sheet that passed every earlier check.

The workspace statusline also uses one control geometry: 28px keys with 17px
glyphs and 8px between groups, growing to 44px touch targets on small/coarse
screens. Support and the notifications bell share borders,
surfaces, and hover treatment. Status dots are positioned badges, never a
second layout row that shifts one icon above another. All controls form one
left-aligned strip; no utility group is pushed to the opposite edge. Static-origin
browser checks compare actual hit areas, glyph centers, group gaps, and surface styles.

`pnpm lint:design` also rejects a `<button>` whose face carries an executing
verb (`Revoke`, `Rename`, `Review`, `Sync`, `Use`, `Approve`, `Load N more`,
and the rest of the list in `scripts/quality/design-lint-verbs.mjs`) unless the
control is `icon-btn` or `.go`. The face is every JSX text run *and* every
string literal between the tags, so `{busy ? "Syncing…" : "Sync connectors"}`
is read too, and a tag ends at the first `>` outside braces, so an
`onClick={() => …}` no longer hides the button behind it.

Words stay on a control only when they are the thing chosen, and the control
says so: a tab, radio, switch, menu entry or pressed toggle by its role; the
guest and setup roads (`road`), the unlock screen's mode switch
(`unlock__switch`), a menu's entries (`account-switcher__*`,
`signin__menu-item`), and `choice` for any other button whose words name its
object — a sign-in method, a walkthrough. `choice` is a claim a reviewer
checks, not an escape hatch: a verb that executes is a key.

The ledger in `tools/quality/design-button-baseline.json` is empty and stays
empty. A file may not exceed its recorded count, and a file that improves
must have that count lowered in the same change. New files start at zero. `impeccable detect` runs on the
same pre-commit path and fails the commit on a primary finding.
