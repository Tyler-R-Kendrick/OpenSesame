# Browser validation failure accounting

Date: 2026-09-08

The static-origin and unlock harnesses previously discarded every console error
containing a 404 status. That allowance was broader than the deployment behavior
it intended to model and could hide an unrelated failure.

Both harnesses now record unsuccessful HTTP responses and console errors through
one observer. Only the static deep-link case admits one exact, top-level document
404 and its matching browser-generated console message. GitHub Pages serves that
document through its SPA fallback; the test also requires sign-in and guest
controls to render. Asset errors, unrelated navigation, subframes, duplicate
failures, and server errors remain fatal. The unlock harness has no exception.

Four observer regression tests exercise these distinctions. The tightened real
Chromium journeys passed 53 static checks and 54 unlock/authentication checks,
with no unexpected HTTP failures, console errors, page errors, or loopback calls.
No assertions were removed and no broader ignore was introduced.
