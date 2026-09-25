# `/i/:ref`, `/approve/:ref` and Access › Requests' hosted rows (ADR 0140 step 9)

Before/after from two real Pages builds (`VITE_BASE=/OpenSesame/`), walked
with the same steps: `origin/main` at `166811cb` (built before any change on
this branch, its `dist/` kept apart and restored for the capture) and this
branch. Phone 390×844 (touch context) and desktop 1280×900 (mouse). Every
number below was printed by the capture run, not written from the diff.

The journey, per width, on one fresh browser profile with no vault:

1. open `…/OpenSesame/i/<ref>#state=evidence` cold → Connect → Approve with
   passkey (a virtual WebAuthn authenticator — CDP
   `WebAuthn.addVirtualAuthenticator`, ctap2/internal, user-verifying, one
   discoverable P-256 credential for the page's origin, as
   `verify:local-iam` does);
2. open `…/i/<ref>#token=osc_clm_leaked.…` cold (a bearer in the fragment);
3. open `…/approve/areq_evidence_approve?utm=telegram` cold → Connect → type
   the six-digit code → tick the confirmation → Touch your passkey to
   approve;
4. open `…/approve/areq_evidence_deny` → Connect → type the code → Deny;
5. open `…/approve/areq_evidence_policy` → Connect → code → confirm → Touch
   your passkey to approve — the stand-in mints this activation under a
   policy other than the requirement showed;
6. open the base → Continue as guest → Access › Requests.

**The Identity API was a stand-in.** This environment has none. Both builds
were served with the same `os-runtime-config.json` naming
`https://identity.evidence.example`, and
`apps/pages/scripts/lib/capture-ceremony-steps.mjs` with
`capture-approval-steps.mjs` answer exactly these routes there:
`GET /v1/principals/me` → 401, `POST /v1/principals/provisional` (Connect's
provisional principal), `GET /i/{ref}`, `GET /v1/interactions/{ref}` and its
`activation`, `activation/complete`, `approve`, `deny`;
`GET /v1/authorization-requests?status=pending`,
`GET /v1/authorization-requests/{id}` and its `requirement`, `activation`,
`activation/complete`, `approve`, `deny`, `report`; everything else is a 404.
The stand-in binds each activation to the request digest, the verb and the
policy digest it was minted under and refuses a settle for another of any of
them, with the Identity API's codes. The page, its routing, focus, WebAuthn
ceremony (a real assertion from the virtual authenticator) and requests are
the real builds'. Requests the branch sent, as recorded (assertions elided):

- `GET /i/i_EvIdEnCe….0123456789abcdef` (no session)
- `POST /v1/principals/provisional {}` (Connect)
- `GET /v1/interactions/i_EvIdEnCe…`
- `POST /v1/interactions/i_EvIdEnCe…/activation {"requestDigest":"v2:5d41…","decision":"approved"}`
- `POST /v1/interactions/i_EvIdEnCe…/activation/complete {"activationId":"act_1","credentialId":…,"clientDataJSON":…,"authenticatorData":…,"signature":…}`
- `POST /v1/interactions/i_EvIdEnCe…/approve {"requestDigest":"v2:5d41…","activationId":"act_1"}`
- `GET /v1/authorization-requests/areq_evidence_approve`, `…/requirement`
- `POST /v1/authorization-requests/areq_evidence_approve/activation {"decision":"approved","requestDigest":"v2:5d41…:areq_evidence_approve"}`
- `POST …/areq_evidence_approve/approve {"requestDigest":"v2:5d41…:areq_evidence_approve","activationId":"act_1","comparisonValue":"424242"}`
- `POST …/areq_evidence_deny/activation {"decision":"denied",…}`, then `…/deny` naming `act_2`
- `POST …/areq_evidence_policy/activation {"decision":"approved",…}` — and nothing after it: the challenge named another policy, so no passkey was asked for and nothing was settled
- `GET /v1/authorization-requests?status=pending` (Access › Requests)

Where the harness serves the build: `static-origin-harness.mjs` used to treat
any path ending in `.<something>` as a missing asset, and an interaction
reference ends in `.<tag>`; GitHub Pages answers such a path with
`404.html` (a copy of `index.html`) like any other, so the harness now does
too for `/i/<ref>`. Both captures ran on the fixed harness.

| Sheet | Before | After |
|---|---|---|
| `*-i-arrival` | front door (`.unlock` 1); fragment still in the address; focus on the sign-in field | first render `…/i/<ref>`, fragment gone; `.unlock` 0; h1 Approve a request, Read the request (warn mark: Sign in to answer this request.), the Connect note; focus on Connect (44×44 phone / 32×32 desktop, `:focus-visible`) |
| `*-i-review` | front door | Match 42, From / Resource / Expires; `.go` 44×44 / 40×40, focused |
| `*-i-approved` | front door, 0 ok marks | Approved, 1 ok mark, 0 `.note`; focus on the answer |
| `*-i-refused` | front door, `#token=` still in the address | address `…/i/<ref>` with no fragment; Refused (err mark: carried credential material); nothing resolved |
| `*-approve-review` | front door, `?utm=` still in the address | address `…/approve/areq_evidence_approve`; `.unlock` 0; who asks, good until, request, would allow, needs; focus on the six-digit code (358×44 / 480×32) |
| `*-approve-approved` | front door, 0 ok marks | Approved, 1 ok mark, 0 `.note` |
| `*-approve-denied` | front door | Denied, through an activation minted for the deny |
| `*-approve-refused` | front door, 0 marks | This request could not be decided (err mark: the rules for this request changed…), 1 err mark; the passkey was never asked for |
| `*-access-requests` | h2 Local requests only, `#hosted-requests` 0 | Requests for you · 1 above Local requests; 1 row, 1 link to `/approve/…` (44×44 / 24×24), 0 approve buttons |

## `/i/:ref` on a device with no vault

![390 i arrival](390-i-arrival.png)

![390 i review](390-i-review.png)

![390 i approved](390-i-approved.png)

## A refusal: a link that carried a bearer

![390 i refused](390-i-refused.png)

## `/approve/:ref`: review, approve, deny

![390 approve review](390-approve-review.png)

![390 approve approved](390-approve-approved.png)

![390 approve denied](390-approve-denied.png)

## A refusal: an activation minted under another policy

![390 approve refused](390-approve-refused.png)

## Access › Requests with a hosted row

![390 access requests](390-access-requests.png)

## Desktop

![1280 i arrival](1280-i-arrival.png)

![1280 i review](1280-i-review.png)

![1280 i approved](1280-i-approved.png)

![1280 i refused](1280-i-refused.png)

![1280 approve review](1280-approve-review.png)

![1280 approve approved](1280-approve-approved.png)

![1280 approve denied](1280-approve-denied.png)

![1280 approve refused](1280-approve-refused.png)

![1280 access requests](1280-access-requests.png)

## How

```bash
J=docs/evidence/2026-09-25-approval-routes/journey.json
# before: origin/main's own build (166811cb), its dist/ restored to apps/pages/dist
# both builds: dist/os-runtime-config.json = {"identityApi":"https://identity.evidence.example"}
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium node apps/pages/scripts/capture-evidence.mjs capture before "$J"
VITE_BASE=/OpenSesame/ pnpm exec turbo run build --filter=@opensesame/pages
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium node apps/pages/scripts/capture-evidence.mjs capture after "$J"
PLAYWRIGHT_CHROMIUM=/opt/pw-browsers/chromium node apps/pages/scripts/capture-evidence.mjs compose "$J"
```
