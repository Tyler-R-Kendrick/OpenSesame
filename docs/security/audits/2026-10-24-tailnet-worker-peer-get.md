# The Tailscale browser node trusts only the port its start transferred

## Scope

`apps/pages/src/modules/networking.tailnet/browser`: the controller in the page
(`controller.ts`, `controller-requests.ts`), the dedicated Worker that runs the
official Tailscale client (`worker.ts`, `worker-peer-get.ts`), and the protocol
between them (`protocol.ts`). It covers the browser-node stack's default
`nativePeerGET` port and ADR 0204. It answers a Codex security review of #2033
(P2, `worker.ts`).

## Invariant

Code on the page that can reach the browser node gets no network authority
the Networking capability's egress policy would refuse, whatever it posts to
the node's Worker or dispatches on it:

- a peer GET runs only at a URL `approvePeer` allowed;
- the client's own control, relay and log requests run only where `approve`
  allowed them;
- the controller acts only on messages the worker sent.

## How the Worker is reached

- `tailscaleBrowserNode()` (`packages/app-core/src/lib/tailscale/browser-node-port.ts`)
  is a module export that returns the live controller. The controller's
  TypeScript `private worker`, and `requests.worker`, are ordinary properties
  at run time, so `tailscaleBrowserNode().worker` is the `Worker`.
- Code that ran before the node started can also wrap `Worker` or
  `Worker.prototype.postMessage` and capture it.
- `approvePeer` is `ctx.egress.decide` for the `peer-or-local-network` class
  (`decideLocal` in `packages/app-core/src/lib/capabilities/egress.ts`). It
  requires a capability plan that is still approved, a deployment profile that
  permits local authority (`mayPairLocalAuthority`), and a local-network
  address. It ran only in the page, in `BrowserNodeRequests.get`.

## Findings

| Severity | Finding | Fix |
| --- | --- | --- |
| Medium | `worker.ts` parsed every message posted to the Worker as a command. A `{ kind: "get", id, url }` from anything holding the Worker ran on the default `nativePeerGET` port, not only on a configured native-HTTP route, and the body came back as a `message` event anyone could read. That reached any tailnet peer the node could, past all three `approvePeer` checks, at any id above the high-water mark. | `0ae49bfe9`: a peer GET is accepted only on the port `start` transferred, and `get` was taken off the Worker's own channel. |
| Medium | The controller asked `this.policy.approvePeer(url)` at call time, and `policy` is just as reachable and writable, so replacing it widened the legitimate road. | `0ae49bfe9`: `approvePeer` is bound in a `#private` field at construction, before the node is published. |
| Medium | The worker settled a pending egress decision from any `{ kind: "decision", id, allowed }` posted to the Worker. A forged `allowed: true` let the client reach a control, relay or log destination the policy refused. The id was sequential, so it could be guessed, and a forged reply raced ahead of the controller's, which waits on state writes. | Decision replies ride the start port only. Each reply names the URL and method it decided, and the worker settles a pending request only with a reply that names that same request. `approve` is bound at construction, as `approvePeer` is. |
| Medium (integrity) | The controller set `worker.onmessage` and acted on every `HostMessage`, so `worker.dispatchEvent(new MessageEvent("message", …))` reached it. A synthetic `storage` was written into the vault's node credential. A synthetic `netmap` and `Running` showed a node as connected, and a synthetic `get` answered a pending peer GET. | The controller listens only on its end of the start port and sets no message handler on the Worker. |

## The rule

- **One port per start.** Each `start` creates a `MessageChannel` and
  transfers one port with the `start` message. The worker binds the single
  port of its first `start`. A later `start`, or one carrying no port or
  several, starts nothing.
- **Everything after `start` rides that port, both ways.** That covers peer
  GET grants, egress decisions, `login`, the native HTTP and close commands,
  and every message the worker sends. The Worker's own channel carries `start`
  alone. The worker acts on nothing else posted there, and the controller
  listens to nothing posted or dispatched there.
- **The Worker's `error` event is the one exception.** It only stops the node,
  and `stop()` already lets any caller do that.
- **The page's end lives only in `#private` fields.** It is held by the
  controller and by `BrowserNodeRequests`, beside the bound `approve` and
  `approvePeer`. A grant goes on it only after `approvePeer` allowed that exact
  URL. A decision goes on it bound to the request it answers. So code that
  reaches the controller can obtain only the decisions the policy itself would
  make.
- **What other reachable entry points can still do.** `node.get`,
  `captureNativeHTTP` and `stop` remain callable. They carry the same checks
  as before: the egress policy, the configured native-HTTP route, and
  retirement.

## Residual risk

- **Code that runs before the node starts.** Such code can wrap `Worker`,
  `MessageChannel` or `MessagePort` and sit between the controller and the
  worker. Nothing in the page can detect that.
  - The deployment bounds it. The PWA's Content-Security-Policy
    (`script-src 'self' 'wasm-unsafe-eval'`) admits no inline or third-party
    script, and the origin should serve nothing else.
  - On the shared `github.io` origin, every other Pages site of the same
    account is same-origin. A dedicated origin removes that.
- **Reply contents.** A reply's contents are not authority. Code that reaches
  the controller can still call its reachable methods, for example to feed a
  pending GET a fabricated answer. That code already holds the unlocked vault
  and the rest of the page. This change keeps its network authority to what
  the policy allows, and does not claim to protect the page from itself.

## Tests

- `worker-peer-get.integration.test.ts`:
  - a peer GET posted on the Worker's channel never reaches `nativePeerGET`,
    while one granted on the start port is fetched and answered;
  - a second `start` cannot rebind the port;
  - the redirect, final-URL and credential/scheme refusals hold on the port.
- `worker-channel.test.ts`:
  - a forged decision on the Worker's channel, and a reply on the port naming
    another URL, settle nothing, and the refusal for the request stands;
  - `login`, `closeHTTP` and `nativeHTTPReady` posted on the Worker act on
    nothing;
  - the worker starts only with exactly one transferred port.
- `controller-peer-grant.test.ts` uses a Worker that is a real `EventTarget`
  and a real `MessageChannel`:
  - a `storage`, `netmap`, `Running` and `get` dispatched on the Worker
    persist nothing, connect nothing and answer nothing;
  - the same messages on the start port connect the node;
  - the decision reply and the GET grant go out on that port, and the Worker
    receives only `start`;
  - a policy reassigned after construction cannot approve a GET.
- Negative controls: each of these tests fails against the code before its
  fix. The peer GET and reassigned-policy tests fail at `67d2aac9e`. The
  `worker-channel.test.ts` tests and the dispatched-event test fail at
  `0ae49bfe9`.
