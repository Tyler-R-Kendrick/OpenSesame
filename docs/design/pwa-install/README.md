# PWA install — design canvas

Design exploration for `apps/pages`: give the app its own way to be installed,
woven into the first-run setup ceremony rather than left to the icon Chromium
hides in the address bar and the three taps buried in Safari's Share sheet.

Published canvas:
<https://claude.ai/code/artifact/3580e5f0-6573-48b8-83fc-13cf4772d2f9>

Shipped as ADR 0085 ([PWA install offer](../../adr/0085-pwa-install-offer.md)),
on top of ADR 0077 ([first-run setup ceremony](../../adr/0077-first-run-setup-ceremony.md))
and ADR 0078 ([an external IdP is the identity service](../../adr/0078-external-idp-is-the-identity-service.md)),
which cut that ceremony to one screen and one question.

## Artboards

| File | What it shows |
|------|---------------|
| `Main.dc.html` | **Live.** The one-screen ceremony on a 390×844 phone, with "Keep it on this device" as its last section. Press Install to watch the offer become a report. The *Install state* chip above the frame is the browser talking — walk `prompt`, `manual`, `dismissed`, `installed` and `unavailable`. |
| `Settings.dc.html` | Where the offer lives once setup is done with: Settings → General, at desktop width. |
| `Wide.dc.html` | The same section above 640px — one centred column, the commit row unpinned from the bottom. |
| `ModelSection.dc.html` | Option A (built): a section of the one screen, withheld where the browser will not install. Low-fi, with its costs stated. |
| `ModelBanner.dc.html` | Option B: a dismissible strip above everything, and why an offer that follows you around is a nag. |
| `ModelStep.dc.html` | Option C (withdrawn): its own ceremony step. Built first, against the two-step ceremony that existed then; ADR 0078 has since made a stepper a regression rather than a placement. |
| `canvas.json` | Two pages (Keep it, Placement model), layout, sticky notes, launch view. |

Copy and states are grounded in the real code: the five `InstallState` values
and their ordering from `lib/install.ts`, the card anatomy from
`components/CeremonyShell.tsx`'s `.found` / `.found__do` pair, the `ways__*`
section voice and thumb bar from `screens/setup.css` and `screens/setup/
WaysIn.tsx`, and the storage claim from `lib/kv.ts` — the vault is held in
OPFS, which is what a browser may evict from a tab and will not from an
installed app.

## Decisions this canvas records

- **A section, not a step and not a banner.** The ceremony is one screen and
  one question (ADR 0078). Installing is not a second question: no wrong
  answer, not asked before the one that matters, and it does not gate the
  commit. So it takes the shape the screen already uses — a `ways__head`
  heading in the same voice as "Add a provider", below the allowlist.
- **A dismissible banner was the tempting cheap answer.** It is also the amber
  notice ADR 0077 deleted, wearing a friendlier hat: a block of colour above
  the question the reader came to answer. An offer that follows you around is
  a nag.
- **The section is withheld where the browser will not install.** ADR 0077's
  own rule, applied again — Unlock is withheld, not greyed, while there is no
  sealed vault. A heading standing over an empty space to explain what your
  browser will not do is a report nobody can act on. On Firefox desktop
  nothing hints the section exists.
- **A refusal is a state, not a disappearance.** Chromium's event is
  single-use, so `dismissed` says so plainly — and it is the one place the app
  points at the browser's own menu, because after a spent event that genuinely
  is the only road left.
- **iOS gets the three taps, in the OS's own words.** Safari exposes no API for
  this at all, so naming them — with the Share and Add-to-Home-Screen glyphs
  drawn inline — is the whole of what the app can do. No button that cannot
  work.
- **The reason is this app's own.** Not "launch faster": a browser can clear a
  tab's storage, this vault lives in that storage, and an installed app keeps
  it. The app asks for persistent storage wherever it observes itself
  installed — and deliberately not a moment earlier, because Chromium refuses
  a plain tab and the one attempt per page load would be spent on that
  refusal. So the claim is one the code keeps.
- **The commit is still the ceremony's.** The install is a `.btn--primary`
  inside the `.found` card, beside the facts that justify it; the foot bar
  keeps its `.go` square reading "Finish setup". See
  [`docs/design/controls.md`](../controls.md), enforced by `pnpm lint:design`.

## Building and re-seeding

The artboards are **generated**. `_style.css` holds the shared design system
(tokens lifted verbatim from `apps/pages/src/styles.css`, the components the
offer reuses, and the `keep__*` vocabulary it adds); `parts/*.html` holds only
what differs per artboard. A Design Component is one self-contained file with
no shared stylesheet, so the block is stamped into each one at build time:

```bash
cd docs/design/pwa-install
node build.mjs            # parts/*.html + _style.css → *.dc.html
```

Then re-seed and republish to the same artifact URL:

```bash
node "<design skill dir>/seed-canvas.mjs" \
  --template "<design skill dir>/payload.template.html" \
  --out opensesame-pwa-install.html \
  --title "OpenSesame PWA Install" \
  --artboard Main.dc.html --artboard Settings.dc.html --artboard Wide.dc.html \
  --artboard ModelSection.dc.html --artboard ModelBanner.dc.html \
  --artboard ModelStep.dc.html \
  --canvas canvas.json
```

The seeded output is gitignored — it is ~2.6 MB of editor code and is fully
regenerated from the artboards above. Edit `parts/*.html`, never the generated
`.dc.html`, unless you are reconciling an edit somebody made in the canvas
editor (in which case `--extract` the published page first and fold the change
back into the part).

`docs/design/**` is excluded from Biome in `biome.json`: these are design-canvas
sources, not application code, and the `.dc.html` format has formatting
constraints of its own.

## Open questions

- Whether `apps/pwa`, the thin client shell, should become installable too. It
  ships a manifest but no service worker, so no browser currently offers it —
  and none of this reaches it.
- Whether the installed app should ever say so on the unlock screen. Drawn as
  not: the unlock screen is the vault gate, and ADR 0077 spent its budget
  clearing that screen of things the reader cannot act on.
- Whether a second optional section would still be acceptable on the
  one-question screen, or whether this one is the ceiling. `ModelSection`
  states the cost: the next such offer will cite this one as precedent.
