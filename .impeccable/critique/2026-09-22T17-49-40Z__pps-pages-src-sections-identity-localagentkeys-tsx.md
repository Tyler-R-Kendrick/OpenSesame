---
target_identity: "file:/home/codex/repos/opensesame/apps/pages/src/sections/identity/LocalAgentKeys.tsx"
target_fingerprint: "sha256:a29b8229776b6c3782a44dfa9e9b44955ee38beb1d710305f58c446448f08ecb"
target_path: /home/codex/repos/opensesame/apps/pages/src/sections/identity/LocalAgentKeys.tsx
timestamp: 2026-09-22T17-49-40Z
slug: pps-pages-src-sections-identity-localagentkeys-tsx
---
---
target: apps/pages/src/sections/identity/LocalAgentKeys.tsx
total_score: 34
max_score: 40
p0_count: 0
p1_count: 0
timestamp: 2026-09-22T17-48-00Z
slug: pps-pages-src-sections-identity-localagentkeys-tsx
---
# Local Agent Keys — control-contract critique (post-fix)

Method: dual-agent (A: design review · B: detector/design-lint)

## Design Health Score

| # | Heuristic | Score | Key Issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | StatusMark + live region outputs |
| 2 | Match System / Real World | 3 | JWK/challenge remain operator-facing by design |
| 3 | User Control and Freedom | 4 | Cancel/Keep/Close exits preserved |
| 4 | Consistency and Standards | 4 | icon-btn / .go aligned with Identity chrome |
| 5 | Error Prevention | 3 | Confirm-to-revoke kept; alert live regions restored |
| 6 | Recognition Rather Than Recall | 3 | Challenge JSON still a handoff |
| 7 | Flexibility and Efficiency | 3 | Sign-out only when sessioned |
| 8 | Aesthetic and Minimalist Design | 4 | Explainer captions removed |
| 9 | Error Recovery | 3 | StatusMark + hidden alerts |
| 10 | Help and Documentation | 3 | Sentences on aria-label/title |
| **Total** | | **34/40** | **Good** |

## Design Specificity Verdict

**LLM:** Product-authored Identity ceremony; Agent keys now match enrollment's icon grammar.
**Deterministic scan:** 0 findings on agent/passkey targets; design-lint clean.
**Visual overlays:** CLI-only (no Chromium for detect overlay).

## Priority Issues (addressed this run)

- **[P0] Word-verb execute buttons** → icon-btn / .go with aria-label (agent + passkey + session).
- **[P0] Explainer captions** → removed from Agent keys, Agents rows, Local directory lede, Passkeys.
- **[P1] Status as prose/`note`** → StatusMark + visually-hidden status/alert for contracts.
- **[P1] Challenge commit** → `.go` Verify agent + icon Close.
- **[P2] Sign-out density** → Sign out agent omitted when no session.

## Run notes

verify:keyboard PASS (agent captures refreshed). quality:gate CLEAN. lint:design OK. detect [].
