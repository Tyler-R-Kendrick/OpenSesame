/**
 * Presentation session: holds only admitted independent compartment keys.
 * Never retains the protected vault root (INV-04 / INV-05).
 */

import type { PresentationClass } from "../access/context.js";
import type {
  CompartmentItem,
  CompartmentPlaintext,
  PublishedCompartment,
} from "./registry.js";
import { importCompartmentKey, openCompartmentJson } from "./seal.js";

export type AdmittedKey = Readonly<{
  compartmentRef: string;
  keyEpoch: number;
  cryptoKey: CryptoKey;
}>;

export type PresentationSession = Readonly<{
  presentation: PresentationClass;
  profileId: string | null;
  admitted: readonly AdmittedKey[];
  /** Opaque session id — limited-carry restore must differ. */
  contextId: string;
  /** When true, UI must not show sensitive incident labels (SETTINGS-D adjacent). */
  suppressSensitiveLabels: boolean;
}>;

export type OpenOutcome =
  | {
      kind: "opened";
      presentation: PresentationClass;
      compartmentRef: string;
      plaintext: CompartmentPlaintext;
      session: PresentationSession;
    }
  | {
      kind: "locked";
      reason:
        | "missing_decoy"
        | "corrupt_decoy"
        | "presentation_locked"
        | "no_admitted_key"
        | "key_mismatch";
      session: PresentationSession;
    };

export async function mintPresentationSession(input: {
  presentation: PresentationClass;
  profileId: string | null;
  contextId: string;
  admittedKeys: readonly {
    compartmentRef: string;
    keyEpoch: number;
    rawKey: Uint8Array;
  }[];
}): Promise<PresentationSession> {
  const admitted: AdmittedKey[] = [];
  for (const k of input.admittedKeys) {
    admitted.push({
      compartmentRef: k.compartmentRef,
      keyEpoch: k.keyEpoch,
      cryptoKey: await importCompartmentKey(k.rawKey),
    });
  }
  return {
    presentation: input.presentation,
    profileId: input.profileId,
    admitted: Object.freeze(admitted),
    contextId: input.contextId,
    suppressSensitiveLabels:
      input.presentation === "decoy" || input.presentation === "restricted",
  };
}

type OpenPresentationOpts = Readonly<{
  expectKind?: "decoy" | "restricted" | "limited_carry";
}>;
const defaultOpenPresentationOpts = {} satisfies OpenPresentationOpts;

/**
 * Open presentation content with admitted keys only.
 * Missing/corrupt decoy → locked; never falls back to a protected vault key (UX-E / AT-094).
 */
export async function openPresentation(
  session: PresentationSession,
  published: PublishedCompartment | null | undefined,
  opts: OpenPresentationOpts = defaultOpenPresentationOpts,
): Promise<OpenOutcome> {
  if (
    session.presentation === "locked" ||
    session.presentation === "unchanged"
  ) {
    return {
      kind: "locked",
      reason: "presentation_locked",
      session,
    };
  }

  if (!published) {
    return {
      kind: "locked",
      reason: "missing_decoy",
      session: { ...session, presentation: "locked" },
    };
  }

  if (opts.expectKind && published.kind !== opts.expectKind) {
    return {
      kind: "locked",
      reason: "key_mismatch",
      session: { ...session, presentation: "locked" },
    };
  }

  const admitted = session.admitted.find(
    (a) => a.compartmentRef === published.compartmentRef,
  );
  if (!admitted) {
    return {
      kind: "locked",
      reason: "no_admitted_key",
      session: { ...session, presentation: "locked" },
    };
  }

  const plaintext = await openCompartmentJson<CompartmentPlaintext>(
    admitted.cryptoKey,
    published.sealed,
    {
      compartmentRef: published.compartmentRef,
      keyEpoch: admitted.keyEpoch,
    },
  );

  if (!plaintext) {
    return {
      kind: "locked",
      reason: "corrupt_decoy",
      session: { ...session, presentation: "locked" },
    };
  }

  return {
    kind: "opened",
    presentation: session.presentation,
    compartmentRef: published.compartmentRef,
    plaintext,
    session,
  };
}

/** Wrong key or vault-root key must not open presentation ciphertext. */
export async function tryOpenWithForeignKey(
  foreignRaw: Uint8Array,
  published: PublishedCompartment,
): Promise<CompartmentItem[] | null> {
  const key = await importCompartmentKey(foreignRaw);
  const pt = await openCompartmentJson<CompartmentPlaintext>(
    key,
    published.sealed,
    {
      compartmentRef: published.compartmentRef,
      keyEpoch: published.keyEpoch,
    },
  );
  return pt?.items ? [...pt.items] : null;
}
