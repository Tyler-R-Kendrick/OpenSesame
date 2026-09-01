/**
 * Who this device is signed in as, said the way the screen says it.
 *
 * Two records answer the question and neither is enough alone: the upstream
 * assertion federation saved (which provider, through which broker, and a
 * name or address when the person consented to PII) and the Identity session
 * (which principal, if the deployment has an Identity API at all). This
 * module folds them into one display model so the unlock screen, the shell
 * prompt and the account menu all name the same person the same way.
 *
 * What it never says: a raw pairwise subject. Shoo's `ps_…` and a principal
 * id are opaque tokens; "Signed in as ps_FpbWr3dA…" reads as a bug. A name
 * or an address is used when the assertion carries one; otherwise the
 * provider is named ("Google account") and the principal contributes only
 * its last four characters, the way a vault id does before unlock.
 */

import { briefOrigin } from "@opensesame/os-domain";
import { useEffect, useMemo, useState } from "react";
import {
  type UpstreamIdentity,
  loadSession,
  upstreamByIssuer,
} from "./federation.js";
import {
  type IdentitySession,
  currentSession,
  identityBase,
  useIdentitySession,
} from "./identity.js";
import { signInMethods } from "./settings.js";

export type Account = {
  /** What to call the person — a name, an address, or the provider's account. */
  readonly name: string;
  /** Through which way in, and which broker, plus the principal's tail. */
  readonly detail: string;
  /** The catalog provider id the sign-in went through, for its brand mark. */
  readonly providerId: string | null;
  /** True when there is an Identity principal but no upstream identity yet. */
  readonly guest: boolean;
};

/** The provider a saved assertion came through, in the catalog's own id. */
function providerIdFor(identity: UpstreamIdentity): string | null {
  if (identity.upstreamId === "shoo") return "google";
  if (identity.upstreamId.startsWith("operator:")) {
    const issuer = identity.upstreamId.slice("operator:".length);
    const idp = signInMethods().providers.find(
      (entry) =>
        entry.issuer.replace(/\/+$/, "") === issuer.replace(/\/+$/, ""),
    );
    return idp?.providerId || null;
  }
  return identity.upstreamId;
}

function providerLabelFor(identity: UpstreamIdentity): string {
  if (identity.upstreamId === "shoo") return "Google account";
  if (identity.upstreamId.startsWith("operator:")) {
    const issuer = identity.upstreamId.slice("operator:".length);
    const idp = signInMethods().providers.find(
      (entry) =>
        entry.issuer.replace(/\/+$/, "") === issuer.replace(/\/+$/, ""),
    );
    return idp ? `${idp.label} account` : `${briefOrigin(issuer)} account`;
  }
  const upstream = upstreamByIssuer(identity.issuer);
  if (upstream) return `${upstream.accountKind} account`;
  const base = identityBase().trim();
  if (
    base &&
    identity.issuer.replace(/\/+$/, "") === base.replace(/\/+$/, "")
  ) {
    return "OpenSesame account";
  }
  return `${briefOrigin(identity.issuer)} account`;
}

function brokerFor(identity: UpstreamIdentity): string {
  if (identity.upstreamId === "shoo") return "via shoo.dev";
  return `via ${briefOrigin(identity.issuer)}`;
}

/** `prn · 8f3c` — enough to tell two principals apart, never the whole id. */
function principalTail(session: IdentitySession | null): string | null {
  if (!session) return null;
  const tail = session.principalId.replace(/^prn_/, "").slice(-4);
  return tail ? `prn · ${tail}` : null;
}

function describeAccountDefault(
  session: IdentitySession | null = currentSession(),
): Account | null {
  const identity = loadSession();
  if (!identity && !session) return null;
  const tail = principalTail(session);
  if (!identity) {
    // A provisional principal with nothing vouching for it yet: a guest.
    return {
      name: "guest",
      detail: [tail, "provisional"].filter(Boolean).join(" · "),
      providerId: null,
      guest: true,
    };
  }
  return {
    name: identity.name ?? identity.email ?? providerLabelFor(identity),
    detail: [brokerFor(identity), tail].filter(Boolean).join(" · "),
    providerId: providerIdFor(identity),
    guest: false,
  };
}

export const accountSeams = {
  describeAccount: describeAccountDefault,
};

export function describeAccount(
  session?: IdentitySession | null,
): Account | null {
  return session === undefined
    ? accountSeams.describeAccount()
    : accountSeams.describeAccount(session);
}

/**
 * The account, for a component. Re-derived when the Identity session changes
 * (sign-out clears it, a connect sets it) and when another tab writes the
 * federation session — the two moments the answer can move without a
 * navigation.
 */
export function useAccount(): Account | null {
  // The session the hook already tracks is the one described, so a component
  // and the model never disagree about whether anyone is signed in.
  const session = useIdentitySession();
  // Another tab signing in or out rewrites the federation session; that is
  // the one move the answer can make without this tab navigating.
  const [storageEpoch, setStorageEpoch] = useState(0);
  useEffect(() => {
    const onStorage = () => setStorageEpoch((epoch) => epoch + 1);
    window.addEventListener("storage", onStorage);
    return () => window.removeEventListener("storage", onStorage);
  }, []);
  // Keyed on what identifies the session, not on the object: a hook that
  // hands back a fresh object per render must not make this re-derive (and
  // re-render) forever.
  const sessionKey = session
    ? `${session.principalId}\u0000${session.accessToken}`
    : "";
  // biome-ignore lint/correctness/useExhaustiveDependencies: `session` is fully represented by `sessionKey`; depending on the object itself would re-derive on every render when a caller returns a fresh one.
  return useMemo(() => describeAccount(session), [sessionKey, storageEpoch]);
}
