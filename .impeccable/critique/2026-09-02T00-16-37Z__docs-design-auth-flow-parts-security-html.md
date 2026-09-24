---
target: docs/design/auth-flow (auth configuration canvas)
total_score: 27
max_score: 40
na_heuristics: 
p0_count: 1
p1_count: 3
timestamp: 2026-09-02T00-16-37Z
slug: docs-design-auth-flow-parts-security-html
---
Method: dual-agent (A: design review · B: detector + Playwright evidence)

Target: docs/design/auth-flow (Security settings list, the add-method sheet, unlock step 2) — Operate mode.

| # | Heuristic | Score | Key issue |
|---|-----------|-------|-----------|
| 1 | Visibility of System Status | 3 | No sending/refused states drawn (fixed: spinner on Send, "Did not match" chips, refused state at unlock) |
| 2 | Match System / Real World | 3 | "wrapped", "Argon2id", "seed" in a guest's first screen (fixed: plain copy) |
| 3 | User Control and Freedom | 2 | Remove was one click; the last-key hint offered no road to add a key (fixed: in-card confirmation, alternatives offer the other keys) |
| 4 | Consistency and Standards | 3 | Add / Enroll / Create / Manage for one act; phone glyph on three rows (fixed: Add/Change/Remove rows, Set/Create/Send/Turn on in cards; mail + message glyphs) |
| 5 | Error Prevention | 3 | Verify-before-commit and last-key rule held; unconfirmed Remove did not (fixed) |
| 6 | Recognition Rather Than Recall | 3 | Guest saw three equal Add buttons (fixed: passkey carries the weight) |
| 7 | Flexibility and Efficiency | 2 | Six digits plus a press at unlock; onboarding hint every time (hint shortened; auto-advance left to implementation) |
| 8 | Aesthetic and Minimalist Design | 3 | Fallback warning said three times; check icon as kicker on every card (fixed: once, and the top line is a fact or nothing) |
| 9 | Error Recovery | 2 | "Did not match" named no recovery; no lost-phone road at step 2 (fixed: recovery copy, "Forgotten how to unlock?" at step 2, resend cooldown) |
| 10 | Help and Documentation | 3 | Foot notes are the right help; "Unavailable" rows had no link (fixed: Connectivity button) |
| **Total** | | **27/40** before fixes | |

Deterministic scan (B): detect.mjs ran degraded (css-tree absent, parser deps not resolvable from the skill dir), so selector and contrast rules never evaluated; 63 advisory findings on the generated artboards are all incumbent tokens (h1/h2 size ramp, Google brand colours). Playwright over 24 renders: no page errors, no overflow, every control named, every input labelled. Real findings: a botched stylesheet edit had dropped `.os .panel*` and `.f__input--mono` (repaired from HEAD); `.f__fills-label` and struck-through recovery codes fell to 4.42:1 on the accent wash (moved to `--ink-2`); `unlock__switch` links are under 24px tall (incumbent app CSS, unchanged).

P0 Remove had no gate — fixed. P1 Manage named a recovery it did not offer — fixed. P1 step 2 had no refused state and no lost-phone road — fixed. P1 four verbs for one act — fixed. P2 kicker check icons — fixed. P2 glyph reuse — fixed.

Persona red flags: power user (auto-submit at six digits not drawn), guest first-timer (now one recommended row), lost phone (recovery code + "Forgotten how to unlock?" at step 2; the no-way-in state is copy on that road, not a new screen).

Open questions kept: whether a platform passkey should be allowed to skip the second step per device; whether recovery codes belong to the vault (chosen) or the authenticator.
