# PR #920 — K3 verdict (post-fix)

**Head:** `c9c207f7` (rebased onto `b83b6c8d`)

Original review: **GAPS** — `retryConnect` did not rebuild the peer; missing coverage for reconnect path.

**Applied on branch:** `#connectWithReply` rebuilds peer on retry in `packages/app-core/src/lib/live/guest.ts`; duplicate `JoinReply` import fixed for Biome.

**Verdict:** **MET** for stated live-join persona findings on current head.
