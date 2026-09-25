# `/invoke/:kind`, the authenticator hand-off (ADR 0140 step 10)

Before/after from two real Pages builds (`VITE_BASE=/OpenSesame/`), walked
with the same steps (`journey.json`): `origin/main` at `6c4a2044`, built in a
separate git worktree and its `dist/` copied in for the capture, and this
branch. Phone 390×844 (touch context) and desktop 1280×900 (mouse). Every
number below was printed by the capture run, not written from the diff.

The journey, per width, on one fresh browser profile with no vault:

1. open `…/OpenSesame/invoke/mfa?user_code=abcd-1234` cold;
2. follow "Continue in this browser" → Connect;
3. open `…/invoke/oid4vp?request_uri=https%3A%2F%2Fverifier.evidence.example%2Frequest%2Fr1` cold;
4. open `…/invoke/totp?user_code=ABCD-1234` cold (a kind the spec does not list);
5. open `…/invoke/mfa?request_id=req_evidence&user_code=ABCD-1234` cold.

**The Identity API was a stand-in**, used only by step 2's Connect: both
builds were served with an `os-runtime-config.json` naming
`https://identity.evidence.example`, answered by
`apps/pages/scripts/lib/capture-ceremony-steps.mjs` (`GET /v1/principals/me`
→ 401, `POST /v1/principals/provisional`). The hand-off itself calls nothing.

Every request the page made off its own origin was printed as it was made
(`watchRequests`, `apps/pages/scripts/lib/capture-invoke-steps.mjs`). On the
branch, across both widths, the only ones were the stand-in's
`GET /v1/federated/providers` (the sign-in provider catalog every boot with
an Identity API reads; `origin/main` makes the same call on the same
arrivals), and step 2's `GET /v1/principals/me` and
`POST /v1/principals/provisional`. **No request went to
`verifier.evidence.example`**: the request URI is handed to the app, never
fetched.

| Sheet | Before (`origin/main`) | After (this branch) |
|---|---|---|
| [390](390-invoke-mfa.png) / [1280](1280-invoke-mfa.png) — `/invoke/mfa?user_code=` on a device with no vault | front door (`.unlock` 1); first render `…/invoke/mfa?user_code=abcd-1234`; focus on the sign-in field | first render `…/invoke/mfa` (query gone before the first paint); `.unlock` 0, `.note` 0; h1 Approve with OpenSesame, Code ABCD-1234; `.go` 44×44 / 40×40 → `opensesame://invoke/mfa?user_code=ABCD-1234`, **focused** (focus-visible); fallback key 44×44 / 32×32 → `/OpenSesame/device?user_code=ABCD-1234` |
| [390](390-invoke-fallback.png) / [1280](1280-invoke-fallback.png) — Continue in this browser | nothing to follow | address `…/OpenSesame/device` (code gone); h1 Approve a device; User code field **ABCD-1234** after Connect; Approve device 44×44 / 40×40 |
| [390](390-invoke-oid4vp.png) / [1280](1280-invoke-oid4vp.png) — `/invoke/oid4vp?request_uri=` | front door; `?request_uri=` still in the address | address `…/invoke/oid4vp`; h1 Present a credential with OpenSesame, From verifier.evidence.example; one link → `openid4vp://?request_uri=…`; no fallback; 0 requests to the verifier; `.go` focused |
| [390](390-invoke-unknown.png) / [1280](1280-invoke-unknown.png) — `/invoke/totp` | front door; query in the address; 0 marks | address `…/invoke/totp`; h1 Authenticator request, "OpenSesame did not open" with 1 err mark "Unknown authenticator request."; 0 links; the refusal panel (358×41 / 960×40) takes the focus |
| [390](390-invoke-two-handles.png) / [1280](1280-invoke-two-handles.png) — `request_id` and `user_code` together | front door; both handles in the address | address `…/invoke/mfa`; 1 err mark "This link must contain exactly one request handle."; 0 links, `.note` 0 |

Nothing navigates to a custom scheme by itself: the app link is a key the
person presses, as it was in `apps/ceremonies`. The capture never presses it
(a headless browser has no handler for `opensesame://`); its target is read
from the `href`.

## `.well-known` (not a screen)

The associations are not visible in either build, so they are verified
instead: `apps/pages/vercel.json`'s `buildCommand`, run locally from
`apps/pages`, wrote no `dist/.well-known/` with the three variables unset
("Authenticator association inputs absent; skipping .well-known files."),
wrote `apple-app-site-association` (components `/invoke/*`, derived from
`spec/config/ceremony-routes.json`) and `assetlinks.json` with fake but
valid-shaped values, and failed the build with only one of the three set.
The GitHub Pages build (`VITE_BASE=/OpenSesame/`) writes none.
