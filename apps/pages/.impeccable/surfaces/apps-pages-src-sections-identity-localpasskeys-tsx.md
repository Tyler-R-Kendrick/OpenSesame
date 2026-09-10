---
version: 1
slug: "apps-pages-src-sections-identity-localpasskeys-tsx"
primary_target: "apps/pages/src/sections/identity/LocalPasskeys.tsx"
related_targets: ["apps/pages/src/sections/identity/LocalDirectoryPanel.tsx", "apps/pages/src/sections/identity/LocalMemberships.tsx", "apps/pages/src/sections/identity/LocalIdentitySession.tsx", "apps/pages/src/sections/identity/LocalApplicationSettings.tsx"]
---

# Identity credentials

Operate mode. Extend the existing Identity People rows without changing navigation,
guest entry, colors, typography, or layout. Human vault custodians enroll and revoke
local passkeys; cryptographic verification is not yet an application grant.

## Direction contract

THESIS: Make local identity credentials actionable beside the person they identify.

OWN-WORLD: Existing monochrome panels, mono typography, hairlines and teal focus.

STORY: Enroll passkeys, sign in locally, revoke sessions; assign and remove organization members with explicit roles; register applications with an organization, exact callbacks and allowed scopes without implicitly granting access.

FIRST VIEWPORT: Keep the People toolbar and rows. A native disclosure below each
person reveals compact commands and credential rows, with inline pending/error states.
Organization rows gain a Members disclosure with named identity/role controls and confirmed removal.
Applications gain a native registration disclosure with an organization select,
callback textarea, scope input, explicit save/reload and confirmed removal.

FORM: Local extension of the incumbent list; no concept seed required. Native
keyboard disclosure is the signature interaction; no new decorative motion.

FINISH: unreviewed and undocumented is unfinished; this build ends with the finish review, the verdict, DESIGN.md, and every shipping raster carrying its provenance
