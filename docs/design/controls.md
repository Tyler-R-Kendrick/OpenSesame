# Controls — the two primary actions, and which is which

The vault has exactly two shapes for "the important button", and picking the
wrong one is how a screen stops looking like the rest of the app. This page
names both so the choice is a lookup rather than a judgement call, and
`scripts/design-lint.mjs` (`pnpm lint:design`) holds new code to it.

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

## 2. The in-card action — `.btn--primary`

**A thing to do *here*, beside the facts that justify it.** Pairing a daemon
that discovery just found. Authorizing a connector. Registering a provider.

```html
<div class="found__do">
  <button type="button" class="btn btn--primary">Pair this daemon</button>
</div>
```

- A normal `.btn--primary` with a **text label**. This is correct and
  deliberate: the action belongs to the card's content, not to the screen, and
  its label is doing real work (*which* daemon, *what* authorization).
- It lives inside a `.found` card, an `.alt__body`, or a `.panel__body` —
  never in a screen's foot bar.

## The rule in one line

> A screen's foot commits with `.go`. A card's body acts with `.btn--primary`.

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
5. **Vault commands are persistent icon keys.** The top path strip retains
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

The rules are deliberately narrow. A lint that tried to guess *in general*
whether a button should have been an icon would be wrong constantly; these
check the specific, mechanical things that went wrong the first time.
