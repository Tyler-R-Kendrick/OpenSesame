import type { RootProtectionManifest } from "@opensesame/vault-core";
import type { GuardedProtectionHost } from "./guarded-browser-host.js";
import { reconcileLegacyRecords } from "./legacy-sync.js";
import {
  sealAuthenticatedManifest,
  verifyManifestAuth,
} from "./manifest-auth.js";
import { migrateLegacyHeaderToManifest } from "./migrate-legacy.js";

/** A queued projection cannot borrow a later session's header or root. */
export async function projectProtection(
  host: GuardedProtectionHost,
): Promise<void> {
  const header = host.getHeader();
  if (!header || !host.isUnlocked()) return;
  const raw = host.requireRawRoot();
  if (!header.protection) {
    const { manifest } = migrateLegacyHeaderToManifest({ header });
    const sealed = await sealAuthenticatedManifest(raw, manifest);
    host.assertCurrent();
    await host.persistHeader({ ...header, protection: sealed });
    return;
  }
  // Invalid authentication remains housekeeping's no-op, while cancellation refuses.
  try {
    await verifyManifestAuth(raw, header.protection);
    host.assertCurrent();
  } catch {
    host.assertCurrent();
    return;
  }
  const records = reconcileLegacyRecords(header, header.protection);
  if (!records) return;
  const { authB64: _drop, preferredProtectorId, ...rest } = header.protection;
  const body: Omit<RootProtectionManifest, "authB64"> = {
    ...rest,
    revision: header.protection.revision + 1,
    records,
  };
  if (
    preferredProtectorId !== undefined &&
    records.some((record) => record.protectorId === preferredProtectorId)
  )
    body.preferredProtectorId = preferredProtectorId;
  const sealed = await sealAuthenticatedManifest(raw, body);
  host.assertCurrent();
  await host.persistHeader({ ...header, protection: sealed });
}
