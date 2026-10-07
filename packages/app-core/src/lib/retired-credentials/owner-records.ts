/** Commit bounded trap settings under the policy proved by their original owner. */
import { assertNotDecoySession } from "../decoy-session.js";
import { kvSetDurable } from "../kv.js";
import { tombFileKey } from "../vfs.js";
import { retiredCredentialStorageSeams } from "./credential-lock.js";
import { withAuthenticatedRetiredCredentialOwner } from "./owner-auth.js";
import type { Records } from "./records.js";

export function persistAuthenticatedRecords(
  input: { tomb: string; currentPassword: string },
  records: Records,
  generation: number,
): Promise<void> {
  const { tomb, currentPassword } = input;
  return withAuthenticatedRetiredCredentialOwner(
    tomb,
    currentPassword,
    async () => {
      assertNotDecoySession(generation);
      await kvSetDurable(
        tombFileKey(tomb, "retired-credentials.v1"),
        JSON.stringify(records),
      );
      assertNotDecoySession(generation);
    },
    retiredCredentialStorageSeams.refresh,
  );
}
