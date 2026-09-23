# Controls — icon keys, and which glyph

Read [`DESIGN.md`](../../DESIGN.md) before drawing a control. An action that
executes is an icon key. A word on a button face is a design failure.
`scripts/design-lint.mjs` (`pnpm lint:design`) and `impeccable detect` hold
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

## 1. The terminal commit — `.go`

**The one action that ends the screen you are on.** Unlocking a vault. Sealing
a device. Finishing setup.

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
| one field | that field's label row, `.keyed-row` |
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

## What is enforced

`scripts/design-lint.mjs`, run by `pnpm lint:design`, the `pre-commit` hook,
and a Claude Code `PostToolUse` hook:

1. **No text-labelled primary in a commit bar.** A `*__foot` element containing
   `btn--primary` is the violation this page exists for.
2. **`.go` is not re-implemented.** Only `styles.css` may define `.go`,
   `.go-row` or `.go-verb`; a second copy in a screen stylesheet is drift.
3. **Every `.go` carries an accessible name.** The glyph is not a label.
4. **Every `.go` has a `.go-verb` beside it.** An unlabelled ink square is a
   mystery-meat control.
5. **A commit key has a home** (`commit-key-has-a-home`). An icon-key
   submit sits in `.keyed-row`, `.field-inline`, a `FieldShell` `tail`, or an
   inline one-field form. Anywhere else it is a glyph on a row of its own;
   use `FormCommit`.
6. **A field has a measure** (`field-has-a-measure`). A CSS rule that gives
   an `input`, `select` or `textarea` `width: 100%` also gives it a
   `max-width`: `var(--field-max)`, `var(--text-max)`, or `none` for an
   overlay.
7. **Vault commands are persistent icon keys.** The top path strip retains
   New item (`+`), Import, and Export in empty, filtered, trash, and populated
   views. Each has an accessible name and tooltip. Text-button styles in
   `VaultSection` or `VaultPathbar` are a hard lint failure; render tests pin
   all three commands and their location. Import opens the file picker;
   Export opens the existing encrypted-backup panel, never a plaintext dump.
   The path/count status row stays at the pane bottom in empty and populated
   views; only the item area scrolls, never the command or status strip.

The workspace statusline also uses one control geometry: 28px keys with 17px
glyphs and 8px between groups, growing to 44px touch targets on small/coarse
screens. Support, connection indicators, notifications, and lock share borders,
surfaces, and hover treatment. Status dots are positioned badges, never a
second layout row that shifts one icon above another. All controls form one
left-aligned strip; no utility group is pushed to the opposite edge. Static-origin
browser checks compare actual hit areas, glyph centers, group gaps, and surface styles.

`pnpm lint:design` also rejects a `<button>` whose face carries an executing
verb (`Revoke`, `Authorize`, `Connect`, `Save`, `Copy`, `Load N more`, and
the same family) unless the control is `icon-btn` or `.go`. Existing files
are pinned in `scripts/design-button-baseline.json`. A file may not exceed
its recorded count, and a file that improves must have that count lowered in
the same change. New files start at zero. `impeccable detect` runs on the
same pre-commit path and fails the commit on a primary finding.
