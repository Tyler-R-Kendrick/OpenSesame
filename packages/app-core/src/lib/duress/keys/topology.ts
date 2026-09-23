import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  type MutableJsonObject,
  isBoolean,
  isJsonObject,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
  readString,
} from "../json-boundary.js";
/**
 * Independent compartment key topology (KEYS-A / INV-05).
 * Shared-root project forks are never inventory as isolation.
 */

import { createIndependentCompartmentKey } from "../crypto/slots.js";

export type CompartmentNode = Readonly<{
  compartmentRef: string;
  /** True only when this compartment has its own randomly generated root. */
  independentRoot: boolean;
  /** Shared vault root id when independentRoot is false. */
  sharedRootRef: string | null;
  keyEpoch: number;
}>;

export type CompartmentTopology = Readonly<{
  vaultRef: string;
  nodes: readonly CompartmentNode[];
}>;

export type IndependentNodeResult = Readonly<{
  node: CompartmentNode;
  rootKey: Uint8Array;
}>;

export function createIndependentNode(input: {
  compartmentRef: string;
  keyEpoch: number;
}): IndependentNodeResult {
  return {
    node: {
      compartmentRef: input.compartmentRef,
      independentRoot: true,
      sharedRootRef: null,
      keyEpoch: input.keyEpoch,
    },
    rootKey: createIndependentCompartmentKey(),
  } satisfies IndependentNodeResult;
}

export function createSharedRootNode(input: {
  compartmentRef: string;
  sharedRootRef: string;
  keyEpoch: number;
}): CompartmentNode {
  return {
    compartmentRef: input.compartmentRef,
    independentRoot: false,
    sharedRootRef: input.sharedRootRef,
    keyEpoch: input.keyEpoch,
  };
}

/** Isolation claim is honest only for independently keyed compartments. */
export function assertIndependentIsolation(
  topology: CompartmentTopology,
  compartmentRefs: readonly string[],
): void {
  for (const ref of compartmentRefs) {
    const node = topology.nodes.find((n) => n.compartmentRef === ref);
    if (!node) {
      throw new Error(`independent_keys_required: unknown compartment ${ref}`);
    }
    if (!node.independentRoot) {
      throw new Error(
        "independent_keys_required: shared-root compartment cannot claim isolation",
      );
    }
  }
}

/**
 * Activation packages must not require opening a protected shared root
 * (KEYS-B). Independent compartment keys satisfy this; shared-root does not.
 */
export function canBootstrapActivationWithoutProtectedRoot(
  topology: CompartmentTopology,
  admitted: readonly string[],
): boolean {
  if (admitted.length === 0) return false;
  return admitted.every((ref) => {
    const node = topology.nodes.find((n) => n.compartmentRef === ref);
    return Boolean(node?.independentRoot);
  });
}

export function listIndependentCompartmentRefs(
  topology: CompartmentTopology,
): string[] {
  return topology.nodes
    .filter((n) => n.independentRoot)
    .map((n) => n.compartmentRef);
}
