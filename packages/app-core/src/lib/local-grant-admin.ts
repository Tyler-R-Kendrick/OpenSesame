import { isString } from "@opensesame/os-domain";
import { grantRef, recordReceipt } from "./device-receipts.js";
import {
  LocalDirectoryError,
  withLocalDirectoryLock,
} from "./local-directory.js";
import {
  readLocalGrantRecords,
  writeLocalGrantRecords,
} from "./local-grant-store.js";
import { assertAccessCapability } from "./local-rbac.js";
import { tombUnlocked } from "./vfs.js";

/** Display-only projection. No nonce, bearer, session digest or private handle. */
export type LocalGrantSummary = Readonly<{
  id: string;
  principalId: string;
  applicationId: string;
  organizationId: string;
  scopes: readonly string[];
  issuedAt: number;
  expiresAt: number;
  approvingPrincipalId: string | null;
}>;

/** Unlocked-vault custodian administration; never an agent/channel operation. */
export async function listRecordedLocalGrants(
  tomb: string,
): Promise<LocalGrantSummary[]> {
  return withLocalDirectoryLock(tomb, async () => {
    const records = await readLocalGrantRecords(tomb);
    if (!tombUnlocked(tomb))
      throw new LocalDirectoryError(
        "Unlock this vault before managing its grants.",
      );
    const now = Date.now();
    return records
      .filter((row) => row.expiresAt > now)
      .map((row) => {
        const summary: LocalGrantSummary = {
          id: row.id,
          principalId: row.principalId,
          applicationId: row.applicationId,
          organizationId: row.organizationId,
          scopes: [...row.scopes],
          issuedAt: row.issuedAt,
          expiresAt: row.expiresAt,
          approvingPrincipalId: row.approval?.principalId ?? null,
        };
        return summary;
      });
  });
}

/** Revoke one exact recorded grant without affecting another principal or vault. */
export async function revokeRecordedLocalGrant(
  tomb: string,
  id: string,
): Promise<void> {
  if (!isString(id) || id.length === 0 || id.length > 36)
    throw new LocalDirectoryError(
      "This local grant is unavailable. Reload the list.",
    );
  // Revoking someone's grant is grant administration, whoever holds the tab.
  await assertAccessCapability(tomb, "manage_grants");
  const ended = await withLocalDirectoryLock(tomb, async () => {
    const records = await readLocalGrantRecords(tomb);
    const record = records.find((row) => row.id === id);
    if (!record)
      throw new LocalDirectoryError(
        "This local grant is unavailable. Reload the list.",
      );
    await writeLocalGrantRecords(
      tomb,
      records.filter((row) => row.id !== id),
    );
    return record;
  });
  // The person ended it, as the application can end its own: a receipt either
  // way, written after the lock is released and the revocation has committed.
  await recordReceipt(tomb, "sign_in.revoked", grantRef(ended));
}
