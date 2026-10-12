# Greyscale Pages (before / after)

Two builds of `apps/pages` walked the same way, at desktop (1280×800) and phone (390×844) width.

- `before-*`: the base branch. Teal accent, teal focus rings, teal "Skip", teal slit on the mark.
- `after-*`: this change. Accent is ink, status is glyph and texture, focus is an ink ring, the release-notes pane is paper.

| Frame | What to look at |
| --- | --- |
| `*-door` | The front door. The release-notes pane was a tint of ink (a grey slab); it is now paper with a hairline head. The Skip and the focused road are ink. |
| `*-shell` | The unlocked guest shell. The rail's selected row is inverse video; the command bar is a grey well with the placeholder; the guest name is ink, not teal. |

Measured: no `#0d7268`, `#2fb3a3` or other teal remains in `apps/pages/src/styles.css` or the Pages components. The only colours left are the provider brand buttons on the sign-in screen, which each provider prescribes.
