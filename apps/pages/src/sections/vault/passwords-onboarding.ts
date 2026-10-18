import {
  type FeatureProposal,
  featureById,
  switchCapability,
} from "@opensesame/app-core/lib/capabilities/features.js";
import type { CompositionSnapshot } from "@opensesame/app-core/lib/capabilities/store-types.js";
import { capabilityPorts } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";
import { enablePack } from "@opensesame/app-core/lib/type-packs/index.js";
import {
  commitProposal,
  currentRoots,
} from "../settings/useCapabilityChange.js";

export const PASSWORDS_CAPABILITY = "vault.derived-records" as const;

export const passwordsOnboardingSeams = {
  commitProposal,
  enablePack,
};

export function passwordsOfferNeeded(snapshot: CompositionSnapshot): boolean {
  return !currentRoots(snapshot.selection).includes(PASSWORDS_CAPABILITY);
}

/** Add Passwords to the installation, leaving every other choice as it was. */
export function passwordsProposal(
  snapshot: CompositionSnapshot,
): FeatureProposal {
  return switchCapability(
    {
      roots: currentRoots(snapshot.selection),
      alternatives: snapshot.selection?.chosenAlternatives ?? {},
    },
    featureById("item-types"),
    PASSWORDS_CAPABILITY,
    true,
    snapshot.plan,
    capabilityPorts.CAPABILITY_CATALOG,
  );
}

/** Commit first; the account pack is a consequence of a successful commit. */
export async function commitPasswordsOnboarding(
  snapshot: CompositionSnapshot,
): Promise<string | null> {
  const notice = await passwordsOnboardingSeams.commitProposal(
    snapshot,
    passwordsProposal(snapshot),
  );
  if (notice === null) passwordsOnboardingSeams.enablePack("account");
  return notice;
}
