---
version: 1
slug: "apps-pages-src-screens-localauthorize-tsx"
primary_target: "apps/pages/src/screens/LocalAuthorize.tsx"
related_targets: ["apps/pages/src/App.tsx", "apps/pages/src/screens/useLocalConsent.ts"]
---

## Direction contract

THESIS: A person sees exactly which application requests their identity or an agent's scoped access before consenting.

OWN-WORLD: Inherit Identity's monochrome panels, native controls, mono typography and teal focus; no visual redesign.

STORY: Unlock, review the application, origin, agent when present, and scopes; choose an eligible approving person, verify their passkey, then allow or deny. Keep the issuer window open for revocable access.

FIRST VIEWPORT: One panel: application, origin, named agent and key disclosure when applicable, scopes, labeled person selector, passkey command, then explicit consent. Pending, expired and refused states stay inline.

FORM: Extend the existing broker ceremony within the Identity shell. Native focus and keyboard activation; no new decorative motion or concept seed.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance

## Finish record

Mode: Operate. Existing-world, code-led extension; no visual-world or token refresh.
Fresh independent finish review: ship for the scoped consent UI. The parent
reviewed agent and person consent captures at 1280px and 390px:

- `apps/pages/.impeccable/review/local-agent-consent-1280.png`
- `apps/pages/.impeccable/review/local-agent-consent-390.png`
- `apps/pages/.impeccable/review/local-consent-1280.png`
- `apps/pages/.impeccable/review/local-consent-390.png`

These are browser verification captures, not shipping product imagery. No new
assets or decorative motion. Four browser journeys passed; an earlier
intermittent refusal remains unproven, so this record claims neither reliability
nor full browser IAM completion. DESIGN.md records the actual consent pattern;
the sidecar's existing registration description records its consent handoff.
