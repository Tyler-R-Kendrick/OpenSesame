/**
 * The browsers verify:live-join pairs (ADR 0150 §5): Chromium, Firefox and
 * WebKit, the builds the pinned Playwright installs (`playwright install
 * chromium firefox webkit`), so a run is the same run on any machine. Two
 * people rarely hold the same browser, so the walk pairs every owner with
 * every joiner.
 *
 * Each engine is launched as two browsers on one machine need it to meet:
 *
 * - **host addresses in the clear** (`mdns: "clear"`): every browser ships
 *   hiding them behind mDNS names, which nothing on a CI runner resolves.
 *   Chromium drops `WebRtcHideLocalIpsWithMdns`; Firefox turns
 *   `obfuscate_host_addresses` off. The tunnel walk keeps them hidden
 *   (`mdns: "hidden"`), as shipped.
 * - **loopback candidates**: Chromium's `--allow-loopback-in-peer-connection`,
 *   Firefox's `media.peerconnection.ice.loopback`.
 *
 * And what an engine cannot be told here, so a walk that needs it is not run
 * with it rather than run and excused (`lacks`):
 *
 * - `turn-tls-trust`: trusting the TLS TURN server's throwaway certificate.
 *   Chromium is told to trust its public key alone
 *   (`--ignore-certificate-errors-spki-list`); Firefox and WebKit verify a
 *   TURN server's certificate against their trust stores and take no such
 *   flag, and `ignoreHTTPSErrors` does not reach WebRTC. A real `turns:`
 *   server holds a publicly trusted certificate, which they take.
 * - `relay-protocol`: WebKit's stats name no `relayProtocol` for a relay
 *   candidate, so how it reached the TURN server is the server's word alone
 *   (`checkServer`).
 * - `mdns-hiding`: Playwright's WebKit on Linux never hides host addresses
 *   (Safari does), so its own candidate is the tunnel walk's address and the
 *   half that must not meet without it cannot be taken.
 * - `plain-loopback-socket`: WebKit, as Safari, refuses a plain socket or
 *   fetch to loopback from an https page (mixed content); Chromium and
 *   Firefox let this device through. Where a pair holds WebKit, its carriers
 *   are reached over TLS (`live-tls-front.mjs`), as in production.
 */

import dgram from "node:dgram";
import { chromium, firefox, webkit } from "@playwright/test";

export const ENGINES = ["chromium", "firefox", "webkit"];

/**
 * Firefox's own console error when ICE gives up ("add a STUN server and see
 * about:webrtc"), written by the browser, not the app. It is expected in the
 * walks that must not connect (`NO_ROUTE_STEPS`) and fails a run anywhere
 * else, where the walk's own join check fails too.
 */
export const BROWSER_ICE_FAILED =
  /^\[JavaScript Error: "WebRTC: ICE failed, (?:add a STUN server|your TURN server appears to be broken)/;
export const NO_ROUTE_STEPS = [
  "tunnel-no-address",
  "relayed-rest-wrong",
  "nats-fallback",
];

const LACKS = {
  chromium: new Set(),
  firefox: new Set(["turn-tls-trust"]),
  webkit: new Set([
    "turn-tls-trust",
    "relay-protocol",
    "mdns-hiding",
    "plain-loopback-socket",
  ]),
};

/** Whether `engine` cannot do `what` here (see the header). */
export function lacks(engine, what) {
  return LACKS[engine]?.has(what) ?? false;
}

/** The engines a comma list names, in its order; an unknown name is refused. */
export function enginesFrom(text) {
  const named = text
    .split(",")
    .map((name) => name.trim())
    .filter(Boolean);
  for (const name of named)
    if (!ENGINES.includes(name))
      throw new Error(`unknown browser "${name}" (one of ${ENGINES})`);
  if (named.length === 0) throw new Error("no browser named");
  return [...new Set(named)];
}

/** Which engine a launched browser is. */
export function engineOf(browser) {
  return browser.browserType().name();
}

/**
 * Launch `engine` for the walk. `turnCert` (from `mintTurnCert`) makes
 * Chromium trust the walk's throwaway key, for the TLS TURN server and a
 * TLS-fronted carrier alike; the others cannot be told for WebRTC (`lacks`).
 */
export function launchEngine(engine, { mdns = "clear", turnCert } = {}) {
  const clear = mdns === "clear";
  if (engine === "chromium") {
    // The app is served through Playwright's router, so the page has no
    // address space of its own and Chrome's Local Network Access check would
    // refuse its fetches to a loopback carrier whatever the person allowed.
    // On the real origin the browser asks once; here the check is off and the
    // grant `allowLocalNetwork` makes stands in for that answer.
    const off = ["LocalNetworkAccessChecks"];
    if (clear) off.push("WebRtcHideLocalIpsWithMdns");
    return chromium.launch({
      executablePath: process.env.PLAYWRIGHT_CHROMIUM || undefined,
      headless: true,
      args: [
        "--allow-loopback-in-peer-connection",
        `--disable-features=${off.join(",")}`,
        ...(turnCert?.flag ? [turnCert.flag] : []),
      ],
    });
  }
  if (engine === "firefox")
    return firefox.launch({
      headless: true,
      firefoxUserPrefs: {
        "media.peerconnection.ice.obfuscate_host_addresses": !clear,
        "media.peerconnection.ice.loopback": true,
        // The app reads the clipboard back to clear a copy it made (ADV-29);
        // a person's Firefox asks with a paste prompt, which nobody here
        // answers. These let that read through without the prompt.
        "dom.events.asyncClipboard.readText": true,
        "dom.events.testing.asyncClipboard": true,
      },
    });
  if (engine === "webkit") return webkit.launch({ headless: true });
  throw new Error(`unknown browser "${engine}"`);
}

/**
 * A context's options for `engine`. Firefox has no mobile emulation, so a
 * phone there is a touch screen at a phone's size (`isMobile` is refused).
 * Firefox and WebKit take the walk's throwaway certificate on the page's own
 * sockets and fetches (a TLS-fronted carrier) only by accepting TLS errors;
 * Chromium trusts that one key by flag instead (`launchEngine`).
 */
export function contextOptions(engine, options = {}) {
  if (engine === "chromium") return options;
  const { isMobile: _mobile, ...rest } = options;
  const screen = engine === "firefox" ? rest : options;
  return { ...screen, ignoreHTTPSErrors: true };
}

/**
 * What a person allows on the real origin, granted here: the clipboard (the
 * app copies codes; only Chromium takes a grant, the others write from the
 * click itself) and, in Chromium, a public page reaching a local-network
 * carrier — which Chrome asks the person first.
 */
export async function allowFor(engine, context, page, origin) {
  if (engine !== "chromium") return;
  await context.grantPermissions(["clipboard-read", "clipboard-write"], {
    origin,
  });
  const cdp = await context.newCDPSession(page);
  await cdp.send("Browser.setPermission", {
    permission: { name: "local-network-access" },
    setting: "granted",
    origin,
  });
}

/**
 * This machine's address on its default route, standing in for a tunnel
 * address in the tunnel walk: an interface every browser gathers on and, while
 * hiding host addresses, names only by an mDNS name — as a tailnet or VPN
 * address is. Loopback does not stand in for one: Firefox gathers no loopback
 * candidate while it hides, so a hint at 127.0.0.1 names a port nothing of its
 * holds. Nothing is sent: connecting a UDP socket only asks the route.
 */
export function defaultRouteAddress() {
  return new Promise((resolve, reject) => {
    const socket = dgram.createSocket("udp4");
    socket.once("error", (error) => {
      socket.close();
      reject(
        new Error(`no default route for the tunnel walk: ${error.message}`),
      );
    });
    socket.connect(9, "192.0.2.1", () => {
      const { address } = socket.address();
      socket.close();
      if (address.startsWith("127.") || address.startsWith("169.254."))
        reject(new Error(`no usable tunnel address (${address})`));
      else resolve(address);
    });
  });
}
