# Remote support boundary — 2026-09-08

## Root cause and implemented boundary

The optional AG-UI transport could send a rich semantic context without a
per-request preview and had no implemented authenticated browser transport.
The new v2 wire is a closed allowlist: user-authored question, authored page and
route IDs, and at most 32 authored feature IDs. History, predicates, tool state,
control labels and live vault/Host details are not copied. Pattern redaction
runs before preview and again at the proxy; questions are limited to 2000
characters and serialized payloads to 8192 bytes.

Every remote request pauses for an immutable preview and single-use Send once
decision. Cancellation, unmount and a 60-second deadline deny it. Remote support
remains off by default, and guest/offline/on-device paths are unchanged. Remote
GuideLang is discarded; remote answers and traces render as inert text.

The browser accepts only a same-origin HTTPS proxy and checks an authenticated
HEAD marker before sending the question. Identity implements `/v1/support`:
validated sessions are required, POST checks the exact deployment origin, and
the closed envelope rejects extra fields. Server-only upstream credentials are
never bundled into Pages. The upstream request uses the existing public-IP
policy, DNS-pinned TLS, no redirects, a 30-second deadline and a 256 KiB response
ceiling. Failure responses never expose upstream bodies or credentials.

## Evidence

- Pages tutorial suite: 41 files, 384 tests passed with two workers; unchanged
  test timeouts. This includes consent, cancellation, transport, sentinel,
  inert-output and existing guest/on-device tutorial cases.
- Identity support proxy: 8 focused cases passed (session/origin checks, extra
  field refusal, safe errors, unsafe endpoint configurations, pre-DNS abort).
- Identity and Pages TypeScript checks passed.
- Support-agent: 6 files, 96 tests passed during implementation.
- Native Jazzer support parser/redaction target: 213297 executions in 21 seconds,
  coverage 43, no crash. This is a bounded fuzz run, not a complete security scan.
- Component tests exercise the preview in jsdom. A real-browser full product
  journey and final integrated gates are separate integration evidence.

## Residuals and recovery

Pattern redaction cannot recognize arbitrary secrets in ordinary prose. The
human must review the exact preview; the UI says this explicitly. Same-origin
malicious JavaScript can act within that origin; this is not an XSS defense.
The operator-selected upstream receives the approved question and semantic IDs.
This implementation does not claim dynamic TLS chaos or complete model-scanner
coverage. The shared-origin Pages demo has no same-origin server and remains
unconfigured. Disabling either server proxy configuration or the Pages endpoint
turns remote support off without affecting local help. Old v1 upstreams require
an explicit v2 receiver migration; no insecure fallback is retained.
