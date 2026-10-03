/**
 * verify:live-netns — live sessions (ADR 0150 §6) across a real network path.
 *
 * `verify:live-join`'s tunnel walk plays a tailnet on one machine by
 * filtering candidate lines inside the page. This one builds the network
 * instead: two Linux network namespaces, each with its own Chromium, joined
 * by a veth pair with multicast off (what a tailnet interface looks like),
 * and a third namespace, the harness, that hosts the carrier and the TURN
 * server but forwards nothing. mDNS candidate hiding is on; nothing in the
 * page is filtered or rewritten. See `lib/live-netns-topology.mjs`.
 *
 * 1. **no address** — the owner names none: the browsers never connect.
 * 2. **address** — the owner names 10.77.0.1 (Routes): they connect over a
 *    pair at that address, with no ICE server.
 * 3. **carrier** — the same, with the codes carried by a Nostr relay both
 *    reach on the harness's address; the relay sees nothing in the clear.
 * 4. **relayed** — the veth is taken down, so there is no route between the
 *    two: only a TURN server, relay only, connects them, relay to relay.
 *
 * The relay and TURN server sit on a private address, local operator
 * authority the shared github.io origin may not reach, so walks 3 and 4 run
 * on `dist-live-dedicated` (`pnpm build:live-dedicated`); 1 and 2 keep the
 * shared origin.
 *
 * Needs Linux with unprivileged user namespaces (no root, no sudo), `unshare`,
 * `nsenter` and python3. Where it cannot build the network it fails, loudly:
 * a skipped network test proves nothing. Every process dies with the run.
 */

import { fileURLToPath } from "node:url";
import { enterNamespace } from "./lib/live-netns-topology.mjs";

const code = await enterNamespace(fileURLToPath(import.meta.url));
if (code !== null) process.exit(code);

const { main } = await import("./lib/live-netns-run.mjs");
const stop = () => process.exit(130);
process.once("SIGINT", stop);
process.once("SIGTERM", stop);
process.exit(await main());
