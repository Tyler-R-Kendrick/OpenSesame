# PR #920 — K3 verdict (post-fix)

**Head:** `a4a07128` (rebased onto `b83b6c8d`)

Original review: **GAPS** — `retryConnect` was a no-op (`accept` guard rejected `connecting` state).

**Applied on branch:** `#connectWithReply` refactor; `retryConnect` rebuilds peer and reconnects after timeout.

**Verdict:** **MET** for stated P1 live/join/end-session findings on current head.
