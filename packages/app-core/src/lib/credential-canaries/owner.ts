import { assertNotDecoySession } from "../decoy-session.js";
import {
  exclusive,
  retiredCredentialStorageSeams,
} from "../retired-credentials/credential-lock.js";
import { retiredCredentialOwnerSeams } from "../retired-credentials/owner-auth.js";
/** Reuse the fresh real-owner ceremony and policy writer lock. */
import { withAuthenticatedRetiredCredentialOwner } from "../retired-credentials/owner-auth.js";
import { authenticationHeaderWitness } from "../vault/store-auth-header.js";
import { readTombHeader } from "../vault/store-header.js";
import type { OwnerProof } from "./protocol.js";
export function currentCredentialObservationIdentity(tomb: string): string {
  const identity = readTombHeader(tomb)?.protection?.vaultId;
  if (!identity)
    throw new Error("An authoritative vault identity is required.");
  return identity;
}
export function withCredentialObservationOwner<T>(
  input: OwnerProof,
  commit: (vaultIdentity: string, assertAuthorized: () => void) => Promise<T>,
): Promise<T> {
  const generation = assertNotDecoySession();
  return exclusive(async () => {
    let result: { value: T } | undefined;
    await withAuthenticatedRetiredCredentialOwner(
      input.tomb,
      input.currentPassword,
      async () => {
        const identity = currentCredentialObservationIdentity(input.tomb);
        const witness = authenticationHeaderWitness(readTombHeader(input.tomb));
        const assertAuthorized = () => {
          assertNotDecoySession(generation);
          if (
            !retiredCredentialOwnerSeams.isRealOwner(input.tomb) ||
            currentCredentialObservationIdentity(input.tomb) !== identity ||
            authenticationHeaderWitness(readTombHeader(input.tomb)) !== witness
          )
            throw new Error(
              "The authenticated owner changed before the settings commit.",
            );
        };
        assertAuthorized();
        result = { value: await commit(identity, assertAuthorized) };
        assertAuthorized();
      },
      retiredCredentialStorageSeams.refresh,
    );
    if (!result) throw new Error("Owner transaction did not commit.");
    return result.value;
  });
}
