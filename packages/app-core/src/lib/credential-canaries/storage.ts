/** Device-at-rest sealed KV, fresh under the shared credential lock. */
import { kvGet, kvSetDurable } from "../kv.js";
import { retiredCredentialStorageSeams } from "../retired-credentials/credential-lock.js";
import { HEADER_PATH, tombFileKey } from "../vfs.js";
import { currentCredentialObservationIdentity } from "./owner.js";
import { type CanaryRegistry, parseCanaryRegistry } from "./records.js";
export function canaryRegistryKey(tomb: string): string {
  return tombFileKey(tomb, "credential-canaries.v1");
}
export async function readCanaryRegistry(
  tomb: string,
  identity?: string,
  assertAuthorized: () => void = () => {},
): Promise<CanaryRegistry> {
  await retiredCredentialStorageSeams.refresh(
    tombFileKey(tomb, HEADER_PATH),
    65536,
  );
  assertAuthorized();
  const authoritative = currentCredentialObservationIdentity(tomb);
  if (identity && authoritative !== identity)
    throw new Error("Vault identity changed.");
  await retiredCredentialStorageSeams.refresh(canaryRegistryKey(tomb), 32768);
  assertAuthorized();
  const raw = kvGet(canaryRegistryKey(tomb));
  return raw
    ? parseCanaryRegistry(raw, tomb, authoritative)
    : { v: 1, tomb, vaultIdentity: authoritative, artifacts: [], events: [] };
}
export async function writeCanaryRegistry(
  records: CanaryRegistry,
  assertAuthorized: () => void = () => {},
): Promise<void> {
  const raw = JSON.stringify(records);
  parseCanaryRegistry(raw, records.tomb, records.vaultIdentity);
  assertAuthorized();
  await kvSetDurable(canaryRegistryKey(records.tomb), raw);
  assertAuthorized();
}
