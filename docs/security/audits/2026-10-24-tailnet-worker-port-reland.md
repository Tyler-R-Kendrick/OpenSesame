# The Tailscale browser node's port channel, re-landed with no sender left reachable

## Scope

This is a follow-up to
[The Tailscale browser node trusts only the port its start
transferred](2026-10-24-tailnet-worker-peer-get.md),
which it does not replace. It covers the same files and ADR 0204:
- `apps/pages/src/modules/networking.tailnet/browser`, specifically
  `controller.ts`, `controller-requests.ts`, `controller-native-stream.ts`,
  `controller-retirement.ts`, `worker.ts`, `worker-peer-get.ts` and
  `protocol.ts`;
- `packages/app-core/src/lib/tailscale/browser-node-{store,port,peer-http}.ts`.

That earlier note was written on #2072, which carried its fixes. #2124 landed
the note and the ADR 0204 amendment without the code. On main at `3c1320a2c`,
every file the fix touches was still #2072's base: the Worker acted on anything
posted to its own channel, and the controller set `worker.onmessage`. The code
re-landed in #2129, on top of the bounded retirement in
`controller-retirement.ts`.

This note records what was reviewed on #2072 after the earlier note was written,
and what the re-land changes about retirement. The earlier note's findings and
rule still stand.

## Findings

| Severity | Finding | Fix |
|---|---|---|
| Medium | The port was `#private`, but closures over it were not (Codex P2 on #2072, `controller-requests.ts`). `node.requests.pending` held each native stream, and that stream's TypeScript-private `options.post` sent any command on the port. `requests.stream()` created such an entry with a caller-supplied check, even with native HTTP off. A `{ kind: "get" }` sent that way skipped `approvePeer`. | Every member of the controller is `#private`. `BrowserNodeRequests` keeps its pending map, readiness and request paths in `#private` members. A native stream holds a frozen channel that sends only its own `nativeHTTPStream`, `pullHTTP` and `cancelHTTP`. |
| Medium | The same sweep found three more reachable writers. `node.listen()` bound a port of the caller's as a source of host messages. `node.receive()` and `node.persist()` wrote a `storage` state into the vault. `node.apply()` echoed a decision with `{ ...message, allowed }`, so a `url` getter could be approved as one URL and sent as another. Every TypeScript-private field, `policy` included, was writable. | At run time the controller shows only the `TailscaleBrowserNode` methods. `assertCurrent` is bound at construction, beside `approve` and `approvePeer`. A decision reply is built from fields read once. |
| Low (integrity) | Retirement ended a drained worker on its `closeHTTP` acknowledgement. While the controller listened on the Worker, a dispatched acknowledgement could end a drain early. | The acknowledgement rides the start port only. A node that made a peer request is terminated when its worker acknowledges `closeHTTP` on the port, or after 60 seconds (`DRAIN_TIMEOUT_MS`). A replacement `start` is refused unless that acknowledgement confirmed the peer transport closed. |

## The rule, added to the earlier note's

- **No reachable object holds a sender over the port.** The request registry,
  the host-message handlers and the state writer are `#private`. A native
  stream's channel sends only that stream's own three commands. The worker
  refuses a reused id, a pull out of sequence, and a command for a stream it
  does not hold (`worker-native-http.ts`).
- **The page's end of the port sits beside four bound functions.** It is held in
  `#private` fields next to `assertCurrent`, `approve` and `approvePeer`, all
  bound at construction.
- **Retirement is bounded and keyed to the port.** A drain ends on the port's
  acknowledgement or after 60 seconds, never on a message posted to the Worker.

## Residual risk

- **Before the node starts:** what the earlier note says still holds. Script
  that runs on this origin before the node starts can wrap `Worker`,
  `MessageChannel` or `MessagePort`.
- **The page itself.** Code that reaches the controller already holds the
  unlocked vault and the rest of the page. This change limits its network
  authority to what the policy allows through the `TailscaleBrowserNode`
  methods. It does not claim to protect the page from itself.
- **The 60-second bound.** A worker that never acknowledges `closeHTTP` keeps
  its peer transport for up to 60 seconds before it is terminated. A replacement
  `start` is refused in that time.

## Tests

- `controller-peer-grant.test.ts` covers the reachability and authority cases:
  - the controller's own and prototype properties are exactly the
    `TailscaleBrowserNode` methods;
  - Codex's path, `requests.stream()` with a caller's check followed by a
    pending entry's `options.post`, sends no `get` past a deny-all policy;
  - `listen` with a forged port, `receive` and `persist` write nothing;
  - `apply` with a `url` getter cannot send `allowed: true` for a refused URL.
- `controller-native-stream.test.ts`: a stream's channel is frozen, and it sends
  only its own three commands under its own id.
- `controller.test.ts`, "withdraws a timed-out peer GET before terminating its
  original drained worker": the test waits for the termination itself, not for a
  counted number of microtasks. Under fake timers it advances about one second,
  far short of the 60-second bound, so only the acknowledged drain can pass it.
- `worker-channel.test.ts`, `worker-peer-get.integration.test.ts`,
  `browser-node-forget.test.ts` and `shared-worker-entry-csp.test.mjs` are as
  the earlier note describes.
- Negative controls:
  - The four reachability tests fail at `c3f0c26e9`, the commit before their
    fix.
  - Against main at `3c1320a2c` and `3ec3e6660`, which carried the earlier note
    but not the code, every test listed here and in the earlier note fails.
  - A nine-case probe written only against main's API fails 9 of 9 on both
    bases, each on its security assertion.
