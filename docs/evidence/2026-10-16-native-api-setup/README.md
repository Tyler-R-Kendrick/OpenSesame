# Native API setup stays configurable

[Desktop comparison](desktop.png) · [Phone comparison](phone.png)

Datadog now exposes the shared API-key configuration form instead of the static
browser refusal and connector-extension advice. These captures demonstrate setup
visibility only: credentials remain blank, Verify and connect stays disabled,
and no provider authentication or operation was attempted.

| Measured at the same route | Before | After |
|---|---|---|
| Configuration controls, each width | 0 | 4: API key, site, application key, Verify |
| Password inputs, each width | 0 | 2 |
| Document width, desktop / phone | 1280 / 390px | 1280 / 390px |
| Phone input / select / Verify height | No controls | 44 / 44 / 44px |

Both captures use the identical journey (`capture.mjs` SHA-256
`11b3b3910c53e6a76bb2e5add1abb3cb5edc968ebc6ccd8d2a33a5c7b845f1e6`):
actual local-only PIN sealing, Settings → Features → Connections, then ordinary
client navigation to Settings → Integrations → Datadog. The static-origin harness
serves the immutable app at `https://tyler-r-kendrick.github.io/`, with stamped
`shared_origin_demo`, base `/`, and `headerSecurity: false`. It supplies no app
backend or provider-success response.

Desktop is 1280 × 900 CSS pixels, DPR 1, mouse; phone is 390 × 844, DPR 3,
coarse touch. Original whole viewports are unchanged. Captures await fonts and
finite animations, without DOM, style, clock, crop, mask, or scroll staging. The
unchanged shared `composeSheet` frames them at native CSS width in a DPR-2 sheet;
this resamples source pixels and is not a latency or equal-scroll comparison.

Before compiled `1876ae9b17c239d000baf5542ea436789a98d6a9`
(tree `2abb8dcf658e2023d8e5946f9ec4a7cd3c6a8692`); after compiled
`1483f508d9fd9e11f4354602e4f7fd3a010f0cb4`
(tree `5b538f133be02d42abd122f05314d7d4318a70bd`, PR #1432).
The intervening changes from the before commit to immediate parent
`c37c38dc616e56162b90c9d06432d8af7432b66b` affect CI, browser verifiers, and visual
references only; they introduce no normally bundled production-source change.
Both archived artifacts contain 254 files.

The after Vite stage completed, but the original whole build failed at worker
output-path resolution (exit 1, 68.46s). Correcting only relative `PAGES_OUT_DIR`
allowed the worker-only completion to pass (exit 0, 1.88s); the original failure
remains retained. Both capture matrices passed with no page/network errors and
normal owned closure: before 18.21s, after 16.53s, each bounded by 180s. An earlier
before attempt used an incorrect Settings tile expectation and failed; its
outputs remain retained separately.

Raw PNG SHA-256 (desktop 1280 × 900; phone 1170 × 2532):

| Capture | SHA-256 |
|---|---|
| before desktop | `e293313fee4a8adeb0889d60a186d365eb79479658453a9dfee3486bb7d0f62a` |
| before phone | `9ab9c26220889c248da6fb47f350fb660321699b6527916aa79c421404257dd4` |
| after desktop | `15f7e3ab38cea600b684ddd82841b80ba0fbe0024eef2b25d34f4c76f50cdebf` |
| after phone | `f2afe47ae9411ddccc9525f1bb620890d36a7ef61fe9d94224c1e1720c945016` |

Capture-receipt SHA-256: before
`58fc6f8daef416eaa3d1038fca5fb287e370224ac9001afb64c74b871ce8d713`;
after `8a8d431bba2418d5b445d302816bd449e2dfe70b92600624c699dcf514fd35aa`.
After artifact-inventory SHA-256:
`c76fd20d15540c49c86c3ca1d6a13dde64ec9f48f84b5f2222e096d52eaa1c4e`.
This gallery does not establish endpoint reachability, successful connection,
provider operations, or completion of all integrations.
