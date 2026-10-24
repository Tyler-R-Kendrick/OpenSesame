# Public web-score gate

`node scripts/quality/web-score.mjs` measures a deployed public site with two
independent scores and fails unless both are perfect:

- Lighthouse desktop: performance, accessibility, best-practices, and SEO
  must all be `1.0`.
- [Is Agentic](https://is-agentic.com/): the public agent-readiness score must
  be exactly `100`.

This gate is separate from `pnpm verify`: it needs the public network, a
Chrome/Chromium binary, and the Is Agentic service. It is a delivery check for
a published site, not a hermetic unit gate.

The Is Agentic check reads the public `/api/v1/report` score. The allowed age
defaults to the provider's six-hour cache window; a report older than that
triggers a fresh scan through `/api/scan/stream`, and the gate fails if the
report is still stale afterward. Set `WEB_SCORE_MAX_AGENTIC_AGE_MS` to a
shorter value when the gate must prove that the scan is newer than a deploy;
the six-hour default accepts the provider's cached public score and is not a
deploy-freshness proof. The public report score is authoritative; the scan
stream's raw `result.score` can use a different scoring contract.

Lighthouse runs up to two times because lab scores can vary by a point. Set
`WEB_SCORE_LIGHTHOUSE_ATTEMPTS=1` to require a single run. The script uses
`pnpm dlx` to run pinned Lighthouse 12.8.2; the first run downloads it.

## Run

```bash
CHROME_PATH=/path/to/chrome node scripts/quality/web-score.mjs
CHROME_PATH=/path/to/chrome node scripts/quality/web-score.mjs https://example.com/path
```

Defaults to the canonical public score page,
`https://is-agentic.com/scan/is-agentic.com`; set `WEB_SCORE_URL` to change the
default. Lighthouse checks the full URL, including path; Is Agentic scores the
origin. Reports are written to `work/web-score/`, which is git-ignored. A failed
run preserves the last Lighthouse or Is Agentic report as
`lighthouse-desktop.failed.json` or `is-agentic.failed.json` for investigation.
Query strings are rejected by default because signed parameters must not be
copied into local reports; set `WEB_SCORE_ALLOW_QUERY=1` for a deliberate public
URL. Loopback, RFC1918, `.local` and `.internal` hosts are rejected because the
origin is sent to Is Agentic; set `WEB_SCORE_ALLOW_PRIVATE=1` only for a host
you intend to disclose.

The bare homepage is not the default. Its rotating recent-scans strip loads
third-party favicons, and cookies or 404s from those unrelated sites make the
homepage's best-practices score change without a code change. The report page
is the stable public artifact that shows the Is Agentic score.

Chrome is discovered from `CHROME_PATH`, common Linux/macOS locations, and the
standard Windows install paths. In a disposable container whose Chrome cannot
use the setuid sandbox, set `WEB_SCORE_NO_SANDBOX=1` explicitly. The script
always uses a throwaway profile, but disabling the renderer sandbox still lets
arbitrary page content reach the host user directly; do not use the opt-in on a
normal workstation.

## Why both scores

Lighthouse answers whether a browser can load and use the page quickly and
accessibly. Is Agentic answers whether an autonomous agent can discover,
retrieve, understand, and recover from the same public origin. A perfect
Lighthouse score with a broken `llms.txt` or invisible 404 is still a failure
for agents; a perfect Is Agentic score with a slow or inaccessible page is
still a failure for people.

## Other measurements

- **Core Web Vitals** — CrUX/PageSpeed field data when a property has enough
  traffic. Lighthouse is the lab check; field data is the production check.
- **Security headers** — `securityheaders.com` or the `headers` block in
  `apps/pages/vercel.json`.
- **OpenSSF Scorecard** — supply-chain posture for the repository, not the
  rendered page; tracked separately from the public-site gate.

Do not add this gate to `pnpm verify` until CI provides a stable pinned
Chrome and permits the network calls. It is intentionally opt-in.
