/**
 * Address hints for a session description (ADR 0150 §6).
 *
 * A browser hides its own addresses behind mDNS names (`<uuid>.local`),
 * which only resolve on the same link. Across a tunnel — a tailnet, a
 * WireGuard or Pangolin mesh, Cloudflare WARP — the other browser cannot
 * resolve them, so neither side has an address to send checks to.
 *
 * The owner names the addresses this device is reachable at. For every host
 * candidate the browser gathered, a copy is added at each address on the
 * same port: the browser's socket for a page with no media permission is
 * bound to every interface, so a check sent to the tunnel address on that
 * port arrives. One side's hint is enough — the other side's address is
 * learned from the checks it sends (a peer-reflexive candidate). Copies that
 * lead nowhere cost a few failed checks and nothing else.
 */

const CANDIDATE =
  /^a=candidate:(\S+) (\d+) (udp|tcp) (\d+) (\S+) (\d+) typ host(.*)$/i;
/** RFC 8839: a foundation is 1 to 32 ice-chars. */
const FOUNDATION_MAX = 32;

function hintLine(line: string, address: string, at: number): string | null {
  const match = CANDIDATE.exec(line);
  if (!match) return null;
  const [, foundation = "", component, transport, priority, , port, rest] =
    match;
  // A distinct foundation: the copy has a different base address.
  const tag = `h${at}`;
  const fresh = `${foundation.slice(0, FOUNDATION_MAX - tag.length)}${tag}`;
  // One below the original, so a route that resolves directly wins.
  const lower = Math.max(0, Number(priority) - 1 - at);
  return `a=candidate:${fresh} ${component} ${transport} ${lower} ${address} ${port} typ host${rest}`;
}

/**
 * Where a direct session should also be reachable on one machine: loopback
 * literals beside mDNS host names, so two tabs on the same device connect
 * without STUN, TURN or disabling `WebRtcHideLocalIpsWithMdns`.
 */
export const SAME_MACHINE_LOOPBACK_HINTS: readonly string[] = [
  "127.0.0.1",
  "::1",
];

/** `sdp` with a copy of each host candidate at each hinted address. */
export function withAddressHints(
  sdp: string,
  addresses: readonly string[],
): string {
  if (addresses.length === 0) return sdp;
  const newline = sdp.includes("\r\n") ? "\r\n" : "\n";
  const out: string[] = [];
  const seen = new Set<string>();
  for (const line of sdp.split(/\r?\n/)) {
    out.push(line);
    const match = CANDIDATE.exec(line);
    if (!match) continue;
    const [, , component, transport, , , port] = match;
    addresses.forEach((address, at) => {
      const key = `${component} ${transport} ${address} ${port}`;
      if (seen.has(key)) return;
      seen.add(key);
      const hinted = hintLine(line, address, at);
      if (hinted) out.push(hinted);
    });
  }
  return out.join(newline);
}
