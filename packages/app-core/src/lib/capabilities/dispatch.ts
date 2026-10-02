/**
 * Dispatch gates (ownership.md §4.2): the checks a contributed entry must
 * pass at the moment it is *used*, not only when it was registered.
 *
 * A registration is fenced by generation, so an entry of a superseded plan
 * is already gone from every listing. That is not the same as authority: the
 * command bar, the keymap and the WebMCP surface may hold an entry they read
 * before a lock, a vault switch or an emergency disable, and act on it after.
 * Each gate therefore resolves the live registration again, from the
 * registry, and refuses — throwing `CapabilityDenied` before any handler
 * runs — unless the lease that registered it is current and the plan still
 * approves what it is for:
 *
 * - a command path or keymap jump names a destination, so its registering
 *   capability must be approved (`assertCurrentCapabilityAuthority`);
 * - a WebMCP tool is owned by an operation (its first tagged id), so that
 *   operation must be approved under the owner's lease
 *   (`assertCurrentOperationAuthority`), and a tool that is not declared
 *   read-only must also be admitted across tabs (`admitOperation`).
 *
 * No registration, no authority: an entry the registry does not hold for the
 * current generation is refused as `NOT_REGISTERED`.
 */

import type {
  ActivationLease,
  AdmissionDecision,
  ContributionKind,
  OperationId,
} from "@opensesame/capability-composition";
import {
  admitOperation,
  assertCurrentCapabilityAuthority,
  assertCurrentOperationAuthority,
} from "./authority.js";
import { type LiveRegistration, liveRegistrations } from "./registry.js";
import {
  type CapabilityDenialCode,
  CapabilityDenied,
  type ContributionEntry,
  isCapabilityDenied,
} from "./runtime-contract.js";

export type NavigationKind = "command-path" | "keymap-jump";

/**
 * The first registration that passes `check`, or the last refusal. Two
 * capabilities may contribute the same destination (an Identity tab drawn by
 * either); one current owner is enough.
 */
function firstAuthorized<K extends ContributionKind>(
  kind: K,
  live: readonly LiveRegistration<K>[],
  check: (registration: LiveRegistration<K>) => void,
): LiveRegistration<K> {
  let refusal: CapabilityDenied = new CapabilityDenied("NOT_REGISTERED", kind);
  for (const registration of live) {
    try {
      check(registration);
      return registration;
    } catch (error) {
      if (!isCapabilityDenied(error)) throw error;
      refusal = error;
    }
  }
  throw refusal;
}

/** Refuse a command path or keymap jump whose owner is no longer approved. */
export function assertNavigationAuthority<K extends NavigationKind>(
  kind: K,
  match: (entry: ContributionEntry<K>) => boolean,
): void {
  firstAuthorized(kind, liveRegistrations(kind, match), (registration) =>
    assertCurrentCapabilityAuthority(
      registration.capability,
      registration.lease,
    ),
  );
}

/**
 * The lease of the live registration of a tool named `name` owned by
 * `operation`, once that operation is approved under it. Throws otherwise.
 */
export function assertToolAuthority(
  name: string,
  operation: OperationId,
  ownerOf: (tool: ContributionEntry<"webmcp-tool">) => OperationId | null,
): ActivationLease {
  const live = liveRegistrations(
    "webmcp-tool",
    (tool) => tool.name === name && ownerOf(tool) === operation,
  );
  return firstAuthorized("webmcp-tool", live, (registration) =>
    assertCurrentOperationAuthority(operation, registration.lease),
  ).lease;
}

const ADMISSION_CODES = {
  "stale-generation": "STALE_LEASE",
  "not-approved": "NOT_APPROVED",
  "no-serialization": "NO_SERIALIZATION",
} as const satisfies Readonly<
  Record<Exclude<AdmissionDecision["reason"], "current">, CapabilityDenialCode>
>;

/**
 * Admit a sensitive operation across contexts under `lease`, then re-check
 * the synchronous authority: the await may have spanned a lock or a commit.
 */
export async function admitSensitiveOperation(
  operation: OperationId,
  lease: ActivationLease,
): Promise<void> {
  const outcome = await admitOperation(operation, lease, () => {
    assertCurrentOperationAuthority(operation, lease);
  });
  const decision = outcome.decision;
  if (decision.reason !== "current" || !decision.admitted) {
    const code =
      decision.reason === "current"
        ? "NOT_APPROVED"
        : ADMISSION_CODES[decision.reason];
    throw new CapabilityDenied(code, operation);
  }
  assertCurrentOperationAuthority(operation, lease);
}
