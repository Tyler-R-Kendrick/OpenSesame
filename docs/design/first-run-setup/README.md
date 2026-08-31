# First-run setup — design canvas

Design exploration for the Pages PWA (`apps/pages`) first-run experience:
replace the "Not connected to an identity service" warning that dominates the
unlock screen with a **setup ceremony** that treats the anonymous first visitor
as the deployment's operator, and withhold the Unlock tab while there is nothing
on the device to unlock.

The ceremony is now **one screen asking one question**, and its answer is a
**list**: the operator adds as many ways in as the deployment wants, and the
sign-in screen offers exactly those and nothing else. An external IdP configured
here *is* the identity service (ADR 0078), so there is no OpenSesame address to
type on the way to one. Two earlier shapes are still on the canvas as the models
they were.

Published canvas:
<https://claude.ai/code/artifact/09666cf7-8624-4d49-bca6-345d0810da5a>

## Artboards

| File | What it shows |
|------|---------------|
| `Main.dc.html` | **Live.** The one-question ceremony on a 390×844 phone. The compiled-in broker is a way in on arrival; add Google, Entra, Okta or any OIDC issuer by picking a preset and filling an issuer and client id, and take any of them back out again with the bin. Empty the list to see what a no-accounts deployment says. |
| `WayIn.dc.html` | The complaint and the answer, side by side: today's amber notice above a live Unlock tab, against the post-setup screen with the notice gone, Unlock withheld, and the paired deployment named along the foot. |
| `Wide.dc.html` | The same ceremony above 640px — one centred column, the action row unpinned from the bottom, with three ways in already listed. |
| `ModelStepper.dc.html` | Model A, built and then outgrown: one question per screen with a progress rail. Correct while there were four questions; furniture once there was one. |
| `ModelChecklist.dc.html` | Model B: one scrolling checklist of expand-in-place rows — the connectivity bar's existing vocabulary, and why it loses on a phone. |
| `canvas.json` | Two pages (Ceremony, Navigation model), layout, sticky notes, launch view. |

Copy is grounded in the real code: the `idp` record and endpoint defaults from
`lib/settings.ts`, provider presets and their field copy verbatim from
`lib/idp-presets.ts` and `screens/setup/providers.ts`, and the field shell from
`components/FieldShell.tsx`.

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
- **One question, so no stepper.** A Host API and a daemon pairing were setup
  questions in earlier shapes; neither is one a first-time visitor has, and both
  live in Settings → Endpoints. With them gone there is one question left, and a
  progress rail over a single step is furniture.
- **A local-only vault is a legitimate outcome of setup**, not a failure of it.
- **The commitment lives at the bottom of the phone.** That is the whole of the
  mobile-navigation fix.
- **Unlock is withheld, not disabled, while no vault is sealed.** A greyed tab
  still claims the action exists. The tab row only appears once there is a
  header on the device to open.
- **Sign-in leads, and it already works.** `TRUSTED_UPSTREAMS` compiles a
  browser-capable upstream into every build, so a deployment nobody has
  configured can still sign people in. The zero-config road is selected on
  arrival.
- **An external provider IS the identity service.** Issuer plus a public client
  id, and the browser runs the whole code flow itself (ADR 0078). The
  OpenSesame identity service is one more way in, offering what a browser
  cannot do alone — org SSO and SAML, LDAP, magic links, guests — never a
  prerequisite for the others.
- **The answer is a list, and the list is an allowlist.** A deployment is
  rarely one provider; and the sign-in screen renders exactly what is here, so
  a road nobody configured is never a button. With no identity service there is
  no bring-your-own globe, no magic link and no guest button, because every one
  of those would only fail.
- **The readout never says "not set" about a road that signs people in.** It
  said exactly that beside a working Okta sign-in, which is what this redraw
  answers.
- **The commit is an ink square,** the shared `.go` control — not a wide text
  button. See `docs/design/controls.md`, enforced by `pnpm lint:design`.

## Open questions

- Whether the ceremony should offer to seal the vault immediately, or always
  hand back to the sign-in screen (drawn as the latter).
