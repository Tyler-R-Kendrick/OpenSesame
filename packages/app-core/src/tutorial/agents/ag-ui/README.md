# Remote support: authenticated, previewed, off by default

Remote support is optional. Written help and the on-device agent work without
an endpoint, Identity, or Host. Neither guest access nor opening the vault
depends on remote support.

## Deployment

Serve Pages on a dedicated HTTPS origin and reverse-proxy `/v1/support` to
Identity on that same origin. Configure Identity, server-side only:

- `OPENSESAME_SUPPORT_UPSTREAM_URL`: exact public HTTPS AG-UI endpoint.
- `OPENSESAME_SUPPORT_UPSTREAM_TOKEN`: server credential, at least 32 characters.

Configure `supportAgentUrl` in the Pages runtime configuration to the absolute
same-origin HTTPS `/v1/support` URL. Never put the upstream credential in a
static file, environment variable baked into JavaScript, or browser storage.
The proxy requires a validated Identity session; the browser sends only its
same-origin session cookie. HEAD returns an active-session marker only after
authentication. POST rechecks authentication and the exact request origin.
An unauthenticated marker check refuses before the question is sent.

The shared-origin GitHub Pages demo has no same-origin server proxy; leave
remote support unconfigured there. Cleartext, cross-origin, credential-bearing,
query-bearing and fragment-bearing endpoints are refused. Runtime config does
not grant an authenticated session.

## Consent and data

Every remote run pauses for an exact immutable JSON preview and a separate
**Send once** decision. Closing, cancelling, expiry, or locking cancels the
pending decision. Suggestions and repair requests pass through the same gate.
The approval expires after 60 seconds; the network operation has a 30 second
deadline. Approval is for one frozen payload, not future requests.

The v2 envelope contains only:

```json
{
  "version": 2,
  "question": "How do I lock?",
  "pageId": "pages",
  "route": "/vault",
  "featureIds": ["vault.lock"]
}
```

No conversation history, predicates, live capability/tool state, control labels,
vault names, connection labels, endpoint details, DOM, storage or form contents
are copied into the envelope. Questions are bounded to 2000 characters and
payloads to 8192 bytes. Common credential assignments, URLs, addresses, long
identifiers, key blocks and number sequences are redacted before preview and
again at the proxy. Pattern redaction cannot identify every secret hidden in
prose: review the preview and do not paste secrets.

The proxy validates the same closed envelope, resolves all destination addresses
through the existing public-address policy, pins TLS to the selected address
with the configured hostname, refuses redirects, and caps the upstream response
at 256 KiB. Errors contain stable codes, never upstream response text or tokens.

## Responses and compatibility

The upstream accepts the v2 envelope and returns SSE AG-UI events. Its own
server-side authored support knowledge supplies instructions; the browser does
not upload a page snapshot. Old v1 receivers must be upgraded explicitly.

Assistant prose and optional trace text render as text. Remote GuideLang is
discarded: a remote answer cannot navigate, invoke tools, alter storage or
perform an authority operation. Checked-in walkthroughs remain available as
explicit human actions; on-device behavior is unchanged.

The AG-UI client remains a lazy dynamic import. Unit tests use explicit
transport and consent seams, never module mocks. Regression tests cover
unauthenticated HEAD refusal, exact-origin POST, immutable single-use preview,
cancellation, payload minimization, sentinel redaction and inert model output.
The existing Jazzer harness discovers `packages/fuzz/src/support_payload.ts`
for coverage-guided parser/redaction testing.
