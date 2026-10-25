/** One owner retires only its exact session transition; a reentrant sign-in keeps its metadata. */
import {
  type FederationSessionGeneration,
  advanceFederationSessionGeneration,
  federationSessionGeneration,
} from "./federation-native-session.js";
import { forgetBrokeredPublication } from "./federation-publication.js";
import { clearFederationSessionJson } from "./federation-session-store.js";

function retireSession(
  expected?: FederationSessionGeneration,
  assertOwner?: () => void,
): FederationSessionGeneration | null {
  const current = (generation: FederationSessionGeneration) => {
    if (federationSessionGeneration() !== generation) return false;
    assertOwner?.();
    return federationSessionGeneration() === generation;
  };
  if (expected !== undefined && !current(expected)) return null;
  const retired = advanceFederationSessionGeneration();
  if (!current(retired)) return null;
  forgetBrokeredPublication();
  if (!current(retired)) return null;
  clearFederationSessionJson();
  return current(retired) ? retired : null;
}

/** Explicit sign-out stays void and retires its original owner even if cleanup starts a newer sign-in. */
export function clearFederationSession(): void {
  retireSession();
}

/** Configuration may cross only its own retirement, never borrow a cleanup or authority-hook successor. */
export function retireOwnedFederationSession(
  expected: FederationSessionGeneration,
  assertOwner: () => void,
): FederationSessionGeneration {
  const retired = retireSession(expected, assertOwner);
  if (!retired)
    throw new Error("Original federation session retirement was superseded");
  return retired;
}
