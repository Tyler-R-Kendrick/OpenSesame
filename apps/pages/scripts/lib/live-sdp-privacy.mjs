/**
 * What a sealed description of a same-machine pair may carry (D3): the app
 * seals loopback hints. Private LAN literals are permitted only when the
 * browsers gathered them themselves, or the owner explicitly named those
 * exact routes and the joiner consented. Other LAN hosts remain refused.
 *
 * A browser hiding its host addresses (the shipped default) puts none in a
 * description, so any such literal is the app's. A walk that shows them in
 * the clear (`live-engines.mjs`, because nothing on a runner resolves an mDNS
 * name) puts its own there: a literal is excused only where a browser of the
 * walk gathered it (`own`), or consent named it (`named`). A runner's
 * address is private; a sandbox's may not be (192.0.2.0/24), which makes a
 * check on the address alone pass where a runner would fail it.
 */

const PRIVATE_IPV4 = /^(10\.|172\.(1[6-9]|2\d|3[01])\.|192\.168\.)/;

export function hostFromCandidateLine(line) {
  const body = line.startsWith("a=candidate:")
    ? line.slice("a=candidate:".length)
    : line;
  return body.split(" ")[4] ?? "";
}

export function isPrivateLanHost(host) {
  if (!host || host.endsWith(".local")) return false;
  if (host === "127.0.0.1" || host === "::1") return false;
  return PRIVATE_IPV4.test(host);
}

const isLoopback = (host) => host === "127.0.0.1" || host === "::1";

/**
 * The first thing wrong with `peers` (each the candidate lines of its remote
 * and local description, or `null` where the browser would not say), or `null`
 * where none. A peer whose descriptions are unreadable is skipped: it is a
 * closed connection of an earlier pair, checked in its own pair. `own` is the
 * set of host addresses the walk's browsers gathered themselves, which a
 * description may carry. `named` holds only routes explicitly selected and
 * accepted through the joiner's address-consent form.
 */
export function sameMachineSdpFault(
  peers,
  who,
  own = new Set(),
  named = new Set(),
) {
  let loopbackSealed = false;
  for (const peer of peers) {
    if (!peer.remote || !peer.local) continue;
    const remoteHosts = peer.remote.map(hostFromCandidateLine);
    const lan = remoteHosts.find(
      (host) => isPrivateLanHost(host) && !own.has(host) && !named.has(host),
    );
    if (lan)
      return `direct: ${who}'s remote description must not carry a private LAN IP (${lan})`;
    const localHosts = peer.local.map(hostFromCandidateLine);
    if ([...localHosts, ...remoteHosts].some(isLoopback)) loopbackSealed = true;
  }
  return loopbackSealed
    ? null
    : `direct: ${who} should seal loopback hints for same-machine pairing`;
}

/**
 * Each peer connection of `page`, as the candidate lines of its remote and
 * local description (`null` where the browser would not say).
 */
async function candidatesOf(page) {
  const { peers } = await page.evaluate(() => {
    // Firefox throws reading a closed connection's descriptions, and the
    // owner's page still holds the connections of the pairs before this one.
    const candidates = (read) => {
      try {
        return (read() ?? "")
          .split("\r\n")
          .filter((line) => line.startsWith("a=candidate:"));
      } catch {
        return null;
      }
    };
    return {
      peers: (window.__rtcPeers ?? []).map((pc) => ({
        remote: candidates(() => pc.remoteDescription?.sdp),
        local: candidates(() => pc.localDescription?.sdp),
      })),
    };
  });
  return peers;
}

/** The host addresses `page`'s own browser gathered, for `own`. */
export async function gatheredHosts(page) {
  const hosts = new Set();
  for (const peer of await candidatesOf(page))
    for (const line of peer.local ?? []) hosts.add(hostFromCandidateLine(line));
  return hosts;
}

/** Read every peer connection `page` made and say if it breaks that. */
export async function assertSameMachineSdpPrivacy(
  page,
  who,
  { own, named } = {},
) {
  const fault = sameMachineSdpFault(await candidatesOf(page), who, own, named);
  if (fault) throw new Error(fault);
}
