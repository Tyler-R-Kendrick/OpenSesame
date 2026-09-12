---
target: apps/control-plane/src/ui/agent-auth-pages.ts
total_score: 13
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
timestamp: 2026-09-04T19-01-49Z
slug: apps-control-plane-src-ui-agent-auth-pages-ts
---
# AgentAuth claim / login ceremony

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 1 | No step, principal, or grant on the original pages |
| 2 | Match System / Real World | 1 | User code / snake_case errors / issuer URL |
| 3 | User Control and Freedom | 1 | Two peer login links; no refuse |
| 4 | Consistency and Standards | 1 | Off DESIGN.md; Confirm as a text verb |
| 5 | Error Prevention | 2 | 6-digit pattern; authorizing unseen scopes |
| 6 | Recognition Rather Than Recall | 1 | Code and grant live off-screen |
| 7 | Flexibility and Efficiency | 2 | OTP autocomplete; no paste-format help |
| 8 | Aesthetic and Minimalist Design | 2 | Sparse by neglect, not Scandinavian authorship |
| 9 | Error Recovery | 1 | Raw API codes in the alert |
| 10 | Help and Documentation | 1 | Policy footnote instead of "the agent printed 6 digits" |
| **Total** | | **13/40** | **Poor** |

## Design Specificity Verdict

**LLM assessment:** Category-interchangeable user-agent HTML. Nothing of OpenSesame (canvas, ink, accent, mono, .go, door-ajar) was present.

**Deterministic scan:** detect.mjs exit 0, `[]` findings. False negative: `.ts` template strings skip HTML analyzers; URL scan needs puppeteer; parser modules missing.

**Visual overlays:** Skipped — mutation unavailable (CSP `default-src 'none'`).

## Overall Impression

A service-owned ceremony with the right *shape* (POST, noindex, escaped token) wearing a 2003 error document. Biggest opportunity: make the grant visible and speak OpenSesame.

## What's Working
- Single-purpose Identity-owned HTML, CSP, escaped interpolation, same-origin return_to
- inputmode/autocomplete/pattern/role=alert
- Done state exists

## Priority Issues
- **[P0] Claim confirms an invisible grant**
- **[P1] Unbranded HTML; Confirm is a text verb**
- **[P1] Login is a hallway with two equal doors**
- **[P1] Errors are protocol codes**
- **[P2] No viewport / focus ring / 44px coarse floor**

## Persona Red Flags
Jordan: jargon, two login CTAs, missing scopes. Sam: alert not wired to field, no owned focus. Riley: paste formats fail with native bubbles; false "scopes shown" sentence.

## Questions to Consider
- Why does the only time a human looks an agent in the eye look like a forgotten error document?
- What would Confirm mean if the grant had to be visible first?
