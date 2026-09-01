# AG-UI support transport (optional, off by default)

This directory implements `SupportAgentPort` against a remote
[AG-UI](https://github.com/ag-ui-protocol/ag-ui) endpoint. It exists so a
deployment that has no on-device model — an older browser, a locked-down
enterprise build, a desktop without the Prompt API — can still answer support
questions. It is not the default and it never becomes the default: with no
endpoint configured, `availability()` returns
`{ kind: "unavailable", reason: "no_remote_endpoint" }` and `run()` refuses
before it constructs a transport.

## The honest privacy difference

The on-device Prompt API answers support questions **without anything leaving
the machine**. This transport does not. When it is on, every question a person
types, plus the page vocabulary (target ids and our authored descriptions,
route ids and titles, state predicate ids and their booleans, capability ids
and titles, goal ids and titles) and the conversation so far, is POSTed to the
endpoint the operator configured.

What still cannot leave, because `sanitizeSupportRequest` rebuilds the request
from primitives and `assertNoStructuralLeak` scans the result before the
transport is built: vault items, folder names, account addresses, note bodies,
passwords, tokens, TOTP seeds, recovery codes, private keys, cookies, storage,
DOM nodes, React internals, getters, and any key whose name matches the egress
denylist. Those are refused — the run throws `SupportEgressRefused` with
nothing on the wire — rather than redacted.

What we cannot promise: a sentence a person types is prose, and no pattern
match can decide whether a secret is hidden inside it. `redactionWarning()`
from `@opensesame/support-agent` says so in the words the UI should show above
this transport. Show it. Do not replace it with a claim of redaction.

## Turning it on

Add one key to the same same-origin `os-runtime-config.json` the app already
reads at boot (`apps/pages/src/lib/runtime-config.ts`, written by
`scripts/deploy-pages.sh`):

```json
{
  "identityApi": "https://id.example.com",
  "supportAgentUrl": "https://support.example.com/agui"
}
```

Then:

```ts
import { createAgUiAgent, loadAgUiEndpoint } from "./tutorial/agents/ag-ui/index.js";

await loadAgUiEndpoint();          // once, at boot
const agent = createAgUiAgent();   // SupportAgentPort, or null if unconfigured
```

`createAgUiAgent()` returns `null` when nothing is configured — not a port that
always refuses — because the caller uses the difference to decide whether the
panel says prompts leave the device at all. `createAgUiSupportAgent({ endpoint })`
is the explicit form, and the one the tests drive.

A build that can set env vars can skip the runtime file entirely:
`VITE_SUPPORT_AGENT_URL` is read at build time and goes through exactly the same
validation.

`readAgUiEndpoint` accepts:

- any absolute `https:` URL;
- `http:` on loopback (`localhost`, `127.0.0.0/8`, `[::1]`, `*.localhost`);
- `http:` on this page's own origin, which only matches when the page itself is
  being served over http — i.e. a dev server.

It refuses everything else, including `http://evil.example` (cleartext to a
third party), `javascript:` and `file:` (not transports at all),
`//evil.example` (scheme-relative, so it has no origin of its own and
resolving it against this page would silently inherit ours), and any URL
carrying embedded credentials, a query string or a fragment.

## The authentication limitation — read this before deploying

**There is no way to authenticate this browser to a third-party AG-UI endpoint,
and this code does not pretend otherwise.**

A key checked into `os-runtime-config.json` is served to everyone who loads the
page. A key in `localStorage` or IndexedDB is readable by any script that
reaches this origin. A key typed into Settings is both. None of those is a
secret, so none of them is offered here: `AgUiEndpoint.headers` is a constant
carrying `content-type` and `accept` and nothing else, there is no header map
in the config, no token field, and no browser-side secret store was invented
for this. Requests go out with `credentials: "omit"`, `redirect: "error"` and
`referrer-policy: no-referrer`.

That leaves two deployments that actually work:

1. **Same-origin reverse proxy (recommended for production).** Put a small
   service on this deployment's own origin at, say, `/agui`. It holds the
   provider credential server-side, adds it to the upstream call, and streams
   the AG-UI events back. Configure `supportAgentUrl` as that same-origin URL.
   The browser sends no credential because it needs none.
2. **Unauthenticated localhost (development).** Run the endpoint on
   `http://127.0.0.1:<port>` and point `supportAgentUrl` at it.

If neither is available, leave the key out. The on-device agent, or no agent,
is the correct answer — not a key pasted into a static deploy.

## The wire format

**Request** — `POST`, `content-type: application/json`. The body is
OpenSesame's own envelope, not an AG-UI `RunAgentInput`, and it is built field
by field in `outbound.ts` so the whole of it is enumerable:

```jsonc
{
  "version": 1,
  "instructions": "…",          // buildSupportInstructions(context)
  "context": {
    "version": 1,
    "pageId": "…",
    "route": "…",
    "targets":      [{ "id": "…", "description": "…", "role": "…", "mounted": true }],
    "routes":       [{ "id": "…", "title": "…" }],
    "state":        [{ "id": "…", "value": false }],
    "capabilities": [{ "id": "…", "title": "…", "available": true }],
    "goals":        [{ "id": "…", "title": "…" }]
  },
  "history": [{ "role": "user", "text": "…" }],
  "question": "…"
}
```

`RunAgentInput` was rejected deliberately: it carries `state`, `tools` and
`forwardedProps` — three open containers we would have to prove empty on every
call — and it pushes the page vocabulary into an opaque `context[].value`
string where a structural scan can no longer see it. If your endpoint fronts an
existing AG-UI agent, map this envelope onto `RunAgentInput` in your own
server; that is a few lines, and it keeps the open containers on the side of
the wire that can be reviewed.

**Response** — an AG-UI event stream (SSE, `text/event-stream`, or the protobuf
framing; `@ag-ui/client` picks by content type). Only these events do anything:

| Event | Effect |
|---|---|
| `TEXT_MESSAGE_START` | records whether that message id is assistant text |
| `TEXT_MESSAGE_CONTENT` / `TEXT_MESSAGE_CHUNK` | `delta` is appended, if the message is assistant text |
| `RUN_ERROR` | ends the run as `AGENT_PROTOCOL_ERROR` |
| `RUN_FINISHED` | ends the stream |

Everything else is discarded without comment: `TOOL_CALL_*`, `STATE_SNAPSHOT`,
`STATE_DELTA`, `MESSAGES_SNAPSHOT`, `CUSTOM`, `RAW`, `ACTIVITY_*`,
`REASONING_*`, `SUBAGENT_*`, `STEP_*`. A server therefore has no path to a Host
mutation, a WebMCP tool, the router or the DOM — not because those calls are
refused, but because this adapter never had a branch that makes one. The only
thing a server can influence is prose and a GuideLang string, and that string
is handed back untrusted for the same parser, validator and registry check
every other guide goes through. `MESSAGES_SNAPSHOT` is dropped along with the
rest: it is a wholesale state replacement, not a message, so a server that
wants to say something streams it.

Bounds the adapter enforces on the stream: 65 536 characters of assistant text,
4 096 events, 512 events of unread backlog, 256 tracked message ids. A stream
that ends without any assistant text is `AGENT_PROTOCOL_ERROR`, not an empty
answer.

## Bundle cost, and why the import is dynamic

`@ag-ui/client@0.0.59` depends on `@ag-ui/core`, `@ag-ui/proto`,
`@ag-ui/encoder`, `rxjs@7.8.1`, `zod@^3`, `protobufjs` (via `@ag-ui/proto`),
`fast-json-patch`, `untruncate-json`, `uuid` and `compare-versions`. Installed,
that subtree is about 22 MB on disk — rxjs alone is 12 MB, protobufjs 3.9 MB,
zod 2.4 MB.

Bundled, the measured cost of that import is **169 KB raw / 38.8 KB gzipped**,
in its own chunk. For comparison this adapter's own code — endpoint validation,
the outbound builder, the transport and the event normalizer together — is
6.5 KB raw / 2.8 KB gzipped. The library is 26× the feature.

So `@ag-ui/client` is loaded by exactly one `await import("@ag-ui/client")`,
inside `transport.ts`, on the first `run()` that actually has an endpoint. In a
production build that puts it three levels down: the entry chunk dynamically
imports the tutorial session, the session dynamically imports this directory,
and this directory dynamically imports the library. The entry chunk does not
reference it, and `index.html` does not preload it — so a vault with no
configured endpoint never downloads a byte of it.

`bundle-hygiene.test.ts` reads the source files to keep that true: every quoted
occurrence of the specifier anywhere under `apps/pages/src` must be a dynamic
`import(...)`, there must be exactly one of them, and there must be no
`console.*` call in this directory. Tests never load the library at all — they
inject an `AgUiTransport`, or an `AgUiClientLoader`, through options.

## Testing seams

```ts
createAgUiSupportAgent({
  endpoint,
  transport,          // AgUiTransport — replaces HTTP and the event stream
  transportOptions: { loadClient, fetchImpl },  // replaces only the module / only fetch
  online,             // () => boolean, defaults to navigator.onLine !== false
});
```

No `vi.mock` anywhere: the seams are ordinary options.
