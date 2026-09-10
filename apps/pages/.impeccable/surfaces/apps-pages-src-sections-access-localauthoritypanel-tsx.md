# Local application grants

Mode: Operate. Extend the existing Access ledger without changing its visual system.

## Direction contract

THESIS: Grants exposes real encrypted application grants without requiring Host.

OWN-WORLD: Existing ruled access records, native buttons, inline confirmation and teal focus; no new tokens.

STORY: Inspect the principal, application, scopes and expiry; confirm revocation; observe the relying party lose access.

FIRST VIEWPORT: Local application grants heading and Reload, concise consent explanation, count and grant rows. Session records remain in Sessions. Host delegation controls remain independently available when configured.

FORM: Reuse the existing local authority panel with a grant-only view; no concept seed for this narrow extension. Keyboard confirmation and focus recovery remain unchanged.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Finish evidence

Disposition: ship for this scoped grant-ledger extension. Independent fresh reviewer
`impeccable_finish_reviewer_local_grants` passed all five review sections with no
material fixes. This is not a release or completion claim for broader browser IAM.

Reviewed implementation: `apps/pages/src/sections/AccessSection.tsx`,
`apps/pages/src/sections/access/LocalAuthorityPanel.tsx`, and
`apps/pages/src/sections/access/local-authority.css`. Grants reuses the grant-only
variant; Sessions retains its combined ledger and both share confirmed revocation.
Native focus scrolling exposes confirmation and restored controls at both widths.

Opened desktop/mobile confirmation and top-of-panel captures:

- `apps/pages/.impeccable/review/local-grants-1280.png`
- `apps/pages/.impeccable/review/local-grants-top-1280.png`
- `apps/pages/.impeccable/review/local-grants-390.png`
- `apps/pages/.impeccable/review/local-grants-top-390.png`

Validation reported by the implementing agent: 14 browser flows and 50 focused
Access tests passed after the native-focus visibility correction. The full Pages
suite passed 3,609 tests before the final native-focus/prose-measure adjustment;
that earlier run is not a final full gate. Registry tests (38), scoped anti-slop,
design lint (298), build/typecheck and structural quality (817 debt, no regression)
passed. Full IAM and release gates are not established by this evidence.

The existing Local sessions and grants entry in `DESIGN.md` and its corresponding
`.impeccable/design.json` component description now document the reused variant.
No shipping raster assets were introduced; the PNGs are review evidence only.
