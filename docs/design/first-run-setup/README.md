# First-run setup — design canvas

Design exploration for the Pages PWA (`apps/pages`) first-run experience:
replace the "Not connected to an identity service" warning that dominates the
unlock screen with a stepped **setup ceremony** that treats the anonymous first
visitor as the deployment's operator, and withhold the Unlock tab while there is
nothing on the device to unlock.

Published canvas:
<https://claude.ai/code/artifact/09666cf7-8624-4d49-bca6-345d0810da5a>

## Artboards

| File | What it shows |
|------|---------------|
| `Main.dc.html` | **Live.** The whole four-step ceremony on a 390×844 phone — Identity, Host, Machine, Review. Type an address, pick a provider preset, run daemon discovery; the rail jumps between steps. |
| `WayIn.dc.html` | The complaint and the answer, side by side: today's amber notice above a live Unlock tab, against the post-setup screen with the notice gone, Unlock withheld, and the paired deployment named along the foot. |
| `Wide.dc.html` | The same ceremony above 640px — one centred column, the action row unpinned from the bottom. |
| `ModelStepper.dc.html` | Option A (built): one question per screen, commitment fixed at the bottom. Low-fi, with its costs stated. |
| `ModelChecklist.dc.html` | Option B: one scrolling checklist of expand-in-place rows — the connectivity bar's existing vocabulary, and why it loses on a phone. |
| `canvas.json` | Two pages (Ceremony, Navigation model), layout, sticky notes, launch view. |

Copy is grounded in the real code: endpoint defaults and the `identityApi` /
`hostApi` / `daemonApi` / `mfaAppUrl` set from `lib/settings.ts`, provider
presets and their field copy verbatim from `lib/idp-presets.ts`, discovery
phases from `components/PlaneNote.tsx`, and the found-card / `or` rule /
expanding-alternative shape from `components/CeremonyShell.tsx`.

## Building and re-seeding

The artboards are **generated**. `_style.css` holds the shared design system
(tokens lifted verbatim from `apps/pages/src/styles.css`, plus the component
rules the ceremony reuses and the `setup__*` vocabulary it adds); `parts/*.html`
holds only what differs per artboard. A Design Component is one self-contained
file with no shared stylesheet, so the block is stamped into each one at build
time rather than copied by hand six times:

```bash
cd docs/design/first-run-setup
node build.mjs            # parts/*.html + _style.css → *.dc.html
```

Then re-seed and republish to the same artifact URL:

```bash
node "<design skill dir>/seed-canvas.mjs" \
  --template "<design skill dir>/payload.template.html" \
  --out opensesame-first-run-setup.html \
  --title "OpenSesame First-Run Setup" \
  --artboard Main.dc.html --artboard WayIn.dc.html --artboard Wide.dc.html \
  --artboard ModelStepper.dc.html --artboard ModelChecklist.dc.html \
  --canvas canvas.json
```

The seeded output is gitignored — it is ~2.3 MB of editor code and is fully
regenerated from the artboards above. Edit `parts/*.html`, never the generated
`.dc.html`, unless you are reconciling an edit somebody made in the canvas
editor (in which case `--extract` the published page first and fold the change
back into the part).

`docs/design/**` is excluded from Biome in `biome.json`: these are design-canvas
sources, not application code, and the `.dc.html` format has formatting
constraints of its own.

## Decisions this canvas records

- **The warning becomes a ceremony.** A deployment with no Identity API is not
  an error to report, it is a deployment nobody has set up yet. The first
  visitor is the operator by default, so the screen asks them the questions
  instead of telling them to go and find someone.
- **Every step is skippable, and says what skipping costs.** A local-only vault
  is a legitimate outcome of setup, not a failure of it.
- **The commitment lives at the bottom of the phone**, in the same place on
  every step. That is the whole of the mobile-navigation fix.
- **Unlock is withheld, not disabled, while no vault is sealed.** A greyed tab
  still claims the action exists. The tab row only appears once there is a
  header on the device to open.
- **Identity API and upstream IdP are two different questions.** The IdP preset
  (Better Auth, WorkOS, Okta, Auth0, other OIDC) registers *through* the
  Identity API by OIDC discovery — so the address comes first, and the preset
  grid stays disabled until it is set.

## Open questions

- Whether the Review step should offer to seal the vault immediately, or always
  hand back to the sign-in screen (drawn as the latter).
- Whether an operator who reaches a deployment that is already configured by
  `os-runtime-config.json` should see the ceremony at all, or only its
  Review step as a confirmation.
