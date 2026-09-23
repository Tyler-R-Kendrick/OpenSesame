/**
 * Restricted + user-maintained decoy compartments with independent keys (UX-A).
 */

import { overlapCast } from "../json-boundary.js";
import {
  type CompartmentTopology,
  assertIndependentIsolation,
  createIndependentNode,
} from "../keys/topology.js";
import {
  type SealedCompartmentBlob,
  importCompartmentKey,
  openCompartmentJson,
  sealCompartmentJson,
} from "./seal.js";

export type CompartmentKind =
  | "restricted"
  | "decoy"
  | "limited_carry"
  | "normal";

export type CompartmentItem = Readonly<{
  id: string;
  title: string;
  folder?: string;
  secret?: string;
  hasTotp?: boolean;
  hasPasskey?: boolean;
  hasAttachment?: boolean;
  preview?: string;
  history?: readonly string[];
  connectorRef?: string | null;
}>;

export type CompartmentPlaintext = Readonly<{
  kind: CompartmentKind;
  label: string;
  items: readonly CompartmentItem[];
  /** Explicit owner-authored safe content only — never forged production state. */
  safeContentAck: true;
}>;

export type PublishedCompartment = Readonly<{
  compartmentRef: string;
  kind: CompartmentKind;
  keyEpoch: number;
  independentRoot: true;
  sealed: SealedCompartmentBlob;
  /** Raw key held only until enrollment seals it into a profile slot. */
  rawKey: Uint8Array;
}>;

export async function createKeyedCompartment(input: {
  compartmentRef: string;
  kind: Exclude<CompartmentKind, "normal">;
  label: string;
  items: readonly CompartmentItem[];
  keyEpoch: number;
}): Promise<PublishedCompartment> {
  const { node, rootKey } = createIndependentNode({
    compartmentRef: input.compartmentRef,
    keyEpoch: input.keyEpoch,
  });
  const key = await importCompartmentKey(rootKey);
  const plaintext = {
    kind: input.kind,
    label: input.label,
    items: input.items,
    safeContentAck: true as const,
  } satisfies CompartmentPlaintext;
  const sealed = await sealCompartmentJson(
    key,
    node.compartmentRef,
    node.keyEpoch,
    overlapCast<
      CompartmentPlaintext,
      import("../json-boundary.js").BoundaryValue
    >(plaintext),
  );
  return {
    compartmentRef: node.compartmentRef,
    kind: input.kind,
    keyEpoch: node.keyEpoch,
    independentRoot: true,
    sealed,
    rawKey: rootKey,
  };
}

export function buildTopology(
  vaultRef: string,
  published: readonly PublishedCompartment[],
): CompartmentTopology {
  return {
    vaultRef,
    nodes: published.map((p) => ({
      compartmentRef: p.compartmentRef,
      independentRoot: true as const,
      sharedRootRef: null,
      keyEpoch: p.keyEpoch,
    })),
  };
}

export function requireIndependentPresentation(
  topology: CompartmentTopology,
  presentationCompartmentRefs: readonly string[],
): void {
  assertIndependentIsolation(topology, presentationCompartmentRefs);
}

export async function openPublishedCompartment(
  rawKey: Uint8Array,
  published: PublishedCompartment,
): Promise<CompartmentPlaintext | null> {
  const key = await importCompartmentKey(rawKey);
  return openCompartmentJson<CompartmentPlaintext>(key, published.sealed, {
    compartmentRef: published.compartmentRef,
    keyEpoch: published.keyEpoch,
  });
}

/** Maintain decoy items under its own key — never mutates protected vault plaintext. */
export async function updateDecoyContents(input: {
  published: PublishedCompartment;
  rawKey: Uint8Array;
  items: readonly CompartmentItem[];
  label?: string;
}): Promise<PublishedCompartment> {
  if (input.published.kind !== "decoy") {
    throw new Error(
      "unsupported_factor: only decoy compartments are user-maintained here",
    );
  }
  const opened = await openPublishedCompartment(input.rawKey, input.published);
  if (!opened) {
    throw new Error("decoy_unavailable");
  }
  const key = await importCompartmentKey(input.rawKey);
  const plaintext = {
    kind: "decoy",
    label: input.label ?? opened.label,
    items: input.items,
    safeContentAck: true as const,
  } satisfies CompartmentPlaintext;
  const sealed = await sealCompartmentJson(
    key,
    input.published.compartmentRef,
    input.published.keyEpoch,
    overlapCast<
      CompartmentPlaintext,
      import("../json-boundary.js").BoundaryValue
    >(plaintext),
  );
  return { ...input.published, sealed };
}
