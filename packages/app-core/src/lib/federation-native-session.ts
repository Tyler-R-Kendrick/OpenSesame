/** Protocol-aware tab memory. Browser adapters own native evidence; scalar persistence cannot restore it. */
export type UpstreamIdentity = {
  issuer: string;
  upstreamId: string;
  idToken: string;
  /** Existing providers may carry JWT or opaque assertions; native SAML carries no OIDC bearer. */
  assertionFormat?: "jwt" | "opaque" | "saml" | "native-oidc";
  /** Per-origin and stable; the identity this app knows the human by. */
  pairwiseSub: string;
  audience: string;
  jwksUri: string;
  expiresAt: number;
  email?: string | undefined;
  name?: string | undefined;
  picture?: string | undefined;
};
/** Native protocol evidence is held by its verified adapter, never serialized as scalar token metadata. */
export function isNativeFederationFormat(value: string | undefined): boolean {
  return value === "saml" || value === "native-oidc" || value === "ldap";
}
export type NativeFederationIdentity = Readonly<
  UpstreamIdentity & {
    assertionFormat: "saml" | "native-oidc";
    idToken: "";
    jwksUri: "";
  }
>;
export type NativeFederationSessionPort = Readonly<{
  read: () => NativeFederationIdentity | null;
  clear: () => void;
}>;
import { currentAuthGeneration } from "./auth-generation.js";
import { notifyFederationSessionChanged } from "./federation-session-events.js";
const brand: unique symbol = Symbol("federation-session-generation");
export type FederationSessionGeneration = Readonly<{ [brand]: true }>;
let generation: FederationSessionGeneration = Object.freeze({ [brand]: true });
let durableGeneration = currentAuthGeneration();
let active: NativeFederationSessionPort | null = null;

function syncDurableGeneration(): void {
  const current = currentAuthGeneration();
  if (current === durableGeneration) return;
  durableGeneration = current;
  generation = Object.freeze({ [brand]: true });
}

export function federationSessionGeneration(): FederationSessionGeneration {
  syncDurableGeneration();
  return generation;
}
/** An opaque object prevents integer reset/wraparound from reviving an old initiating generation. */
export function advanceFederationSessionGeneration(): FederationSessionGeneration {
  durableGeneration = currentAuthGeneration();
  const published: FederationSessionGeneration = Object.freeze({
    [brand]: true,
  });
  generation = published;
  try {
    active?.clear();
  } finally {
    notifyFederationSessionChanged();
  }
  // Return this transition, even if clearing the previous native owner advanced again.
  return published;
}
/** Installation is an adapter lifecycle port, never a scalar-to-verified-identity factory. */
export function bindNativeFederationSession(
  port: NativeFederationSessionPort,
): () => void {
  const previous = active;
  const read = port.read;
  const clear = port.clear;
  advanceFederationSessionGeneration();
  if (active !== previous)
    throw new Error("Native federation session changed during installation");
  active = Object.freeze({
    read() {
      if (port.read !== read || port.clear !== clear)
        throw new Error("Original native federation session changed");
      const identity = read.call(port);
      if (port.read !== read || port.clear !== clear)
        throw new Error("Original native federation session changed");
      return identity;
    },
    clear: () => clear.call(port),
  });
  const installed = active;
  return () => {
    if (active !== installed) return;
    advanceFederationSessionGeneration();
    if (active === installed) active = null;
  };
}
export function readNativeFederationSession(): NativeFederationIdentity | null {
  const original = active;
  if (!original) return null;
  try {
    const identity = original.read();
    if (active !== original) return null;
    if (!identity) return null;
    if (
      !["saml", "native-oidc"].includes(identity.assertionFormat) ||
      identity.idToken !== "" ||
      identity.jwksUri !== "" ||
      !Number.isSafeInteger(identity.expiresAt) ||
      identity.expiresAt <= Date.now()
    ) {
      original.clear();
      return null;
    }
    return identity;
  } catch {
    original.clear();
    return null;
  }
}

export function upstreamIdentityDisplayName(
  identity: UpstreamIdentity,
): string {
  return identity.name ?? identity.email ?? identity.pairwiseSub;
}
