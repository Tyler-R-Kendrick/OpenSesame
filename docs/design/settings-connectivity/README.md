# Settings connectivity — design canvas

Design exploration for the Pages PWA (`apps/pages`) Settings pane: replace the
Connectivity endpoint forms with a phone-status-bar row of connector glyphs that
open a connection ceremony when clicked, and rework the surviving form inputs
around detected defaults.

Published canvas:
<https://claude.ai/code/artifact/ef3483dc-4bdf-4adf-9880-0f95ab1ec33f>

## Artboards

| File | What it shows |
|------|---------------|
| `StatusBar.dc.html` | Three treatments of the connector row — glyph-only, glyph + micro-label, summary chip + popover — with the tradeoff for each. Click a glyph to cycle live / needs-attention / off. |
| `Main.dc.html` | Settings → Connectivity with the endpoint form gone: five core connectors as tiles, ceremony in a side sheet, endpoints collapsed behind a disclosure with no Save button. |
| `Ceremony.dc.html` | The daemon pairing ceremony, stepped — probing on open, one primary action, manual URL only on the nothing-found path. |
| `Fields.dc.html` | Today's Locking / Master password / Planes panels beside the reworked versions, with the five form rules they follow. |
| `Mobile.dc.html` | The same strip in the mobile topbar, ceremony as a bottom sheet. |
| `canvas.json` | Artboard layout, sticky notes, launch view. |
| `_tokens.css` | `apps/pages/src/styles.css` tokens, lifted verbatim, concatenated into each artboard at seed time. |

Copy is grounded in the real code: `usePlaneStatus()` states from
`apps/pages/src/lib/planes.ts`, endpoint defaults from `lib/settings.ts`, and the
connector set from `CAPABILITIES` in `lib/capabilities.ts` plus the three planes.

## Re-seeding after an edit

The published page is a seeded copy of the Claude Design canvas payload. Edit the
`.dc.html` files here, then re-seed and republish to the same artifact URL:

```bash
node "<design skill dir>/seed-canvas.mjs" \
  --template "<design skill dir>/payload.template.html" \
  --out opensesame-settings-connectivity.html \
  --title "OpenSesame Settings Connectivity" \
  --artboard Main.dc.html --artboard StatusBar.dc.html \
  --artboard Ceremony.dc.html --artboard Fields.dc.html \
  --artboard Mobile.dc.html \
  --canvas canvas.json
```

The seeded output is gitignored — it is ~2.3 MB of editor code and is fully
regenerated from the artboards above.

## Open questions

- Which status-bar treatment (`StatusBar.dc.html` is the decision artboard).
- The desktop topbar is `display: none` above 900px today; the strip needs it
  back, or another home.
- The ceremony names the discovered machine before pairing. If
  `discoverTailscaleDaemon` cannot report which machine it found until after the
  probe, that step degrades to "found one".
