---
version: 1
slug: "pps-pages-src-sections-identity-localagentkeys-tsx"
primary_target: "apps/pages/src/sections/identity/LocalAgentKeys.tsx"
related_targets: ["apps/pages/src/sections/identity/LocalAgentEnrollment.tsx", "apps/pages/src/sections/identity/LocalAgentAuthentication.tsx", "apps/pages/src/sections/identity/LocalIdentitySession.tsx", "apps/pages/src/sections/identity/LocalDirectoryPanel.tsx"]
---

# Local agent keys

Mode: Operate. Extend Identity's existing Agents rows; no new visual world.

## Direction contract

THESIS: Enroll an agent's public key and verify possession; never confuse a directory entry or machine proof with human approval.

OWN-WORLD: Existing mono record fields, neutral paper, hairlines, native disclosures and ink actions.

STORY: The custodian enrolls public material. The agent signs a one-use challenge. Verification creates a revocable local session, not application consent.

FIRST VIEWPORT: Agent name and state remain first. An Agent keys disclosure contains flat enrolled-key rows, enrollment fields on request, then challenge and signed-response fields. Native Tab order follows that sequence.

FORM: Incumbent Identity record extension; code-led, no concept seed required. Confirmed revocation and conditional focus restoration are the signature interaction. Existing reduced-motion behavior remains.

FINISH: Independent finish review disposition: ship this bounded agent-key slice with no material fixes. DESIGN.md and the design sidecar record the implemented pattern. Enrollment, challenge, and session captures at 1280px and 390px are in `apps/pages/.impeccable/review/agent-{enrollment,challenge,session}-{1280,390}.png`. These are browser review evidence; no raster imagery or concept comp was added to the product. This verdict does not establish full browser IAM completion or local agent application delegation.
