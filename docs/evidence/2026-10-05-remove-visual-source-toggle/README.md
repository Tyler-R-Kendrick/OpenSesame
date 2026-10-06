# Remove the Visual / Source toggle

Identity › Applications › a local application's **Application registration**
drew a `Visual | Source` toggle above its form. Choosing Source swapped the
form for a YAML textarea over the same registration. That second
representation is gone; the row is one form. (The hosted *Edit application*
form had the same toggle and is the same change; it needs a live Identity API,
so it is covered by `management.test.tsx`, not by a capture.)

Both builds are real: `main` at `eccd2d9d` and this branch, each built with
`vite build` and walked the same way by one script — seal a vault, add
*Browser-local IAM*, open Identity › Applications, open the built-in
`OpenSesame` application's registration editor. Numbers are read from the DOM
by that walk (`facts-before.json`, `facts-after.json`).

| Width | Toggle buttons (Visual, Source) | `editor representation` group | Summary → Organization field |
|-------|--------------------------------|-------------------------------|------------------------------|
| 390 (phone) | 2 → **0** | present → **absent** | 171px → **127px** |
| 1280 (desktop) | 2 → **0** | present → **absent** | 115px → **71px** |

The 44px saved is the toggle's row. Nothing else on the screen moves.

| Sheet | Shows |
|-------|-------|
| `390-registration.png` | Phone, before (left) and after (right) |
| `1280-registration.png` | Desktop, before (left) and after (right) |

Not run here: `verify:mobile` and `verify:keyboard` (no control was added or
resized; two were removed).

Reproduce: build each side with `VITE_BASE=/OpenSesame/ pnpm --filter
@opensesame/pages exec vite build`, then
`PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium node walk-registration.mjs <dist> <out>`.
