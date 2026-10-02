/** Resolve a peer hostname and apply the same address policy as a literal. */
import { host } from "../../../host.js";
import {
  assertSafePeerOrigin,
  peerHostnameNeedsResolution,
  resolvedPeerAddressBlocked,
} from "./origin.js";

export type PeerHostLookup = (hostname: string) => Promise<readonly string[]>;

const MAX_ANSWERS = 8;

function lookupFromHost(): PeerHostLookup | undefined {
  try {
    return host().peerDns?.lookup;
  } catch (error) {
    if (error instanceof Error && error.message.includes("no host installed")) {
      return undefined;
    }
    throw error;
  }
}

/** Lexical origin check, then DNS policy. Throws `unapproved_route`. */
export async function assertPeerOriginResolved(
  origin: string,
  lookup?: PeerHostLookup,
): Promise<URL> {
  const url = assertSafePeerOrigin(origin);
  if (!peerHostnameNeedsResolution(url.hostname)) return url;
  const resolve = lookup ?? lookupFromHost();
  if (!resolve) throw new Error("unapproved_route");
  let addresses: readonly string[];
  try {
    addresses = await resolve(url.hostname);
  } catch {
    throw new Error("unapproved_route");
  }
  if (addresses.length === 0 || addresses.length > MAX_ANSWERS) {
    throw new Error("unapproved_route");
  }
  for (const address of addresses) {
    if (resolvedPeerAddressBlocked(address)) {
      throw new Error("unapproved_route");
    }
  }
  return url;
}
