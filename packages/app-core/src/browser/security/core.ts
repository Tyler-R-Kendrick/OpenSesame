import { bytesToB64 } from "@opensesame/vault-core";
import { composeHost, configureHost } from "../../host.js";
import { kvGet, kvHydrate } from "../../lib/kv.js";
import { kvRefresh } from "../../lib/kv.js";
import { probeRetiredCredential } from "../../lib/retired-credentials/index.js";
import { verifyCurrentCredential } from "../../lib/retired-credentials/owner-auth.js";
import { authenticationHeaderWitness } from "../../lib/vault/store-auth-header.js";
import { readTombHeader } from "../../lib/vault/store-header.js";
import { tombStorageKeys } from "../../lib/vault/tomb-migration.js";
import { HEADER_PATH, PERSONAL_TOMB, tombFileKey } from "../../lib/vfs.js";
import { browserPorts } from "../host.js";

let ready: Promise<void> | null = null;
export function initializeExtensionVault(): Promise<void> {
  if (!ready) {
    configureHost(
      composeHost(browserPorts(), { env: { BASE_URL: "/", DEV: false } }),
    );
    ready = kvHydrate([
      ...tombStorageKeys(PERSONAL_TOMB),
      "opensesame.device-connectors.v1",
    ]);
  }
  return ready;
}
export async function extensionVaultRevision(): Promise<string | null> {
  await initializeExtensionVault();
  await kvRefresh(tombFileKey(PERSONAL_TOMB, HEADER_PATH), 65536);
  const header = readTombHeader(PERSONAL_TOMB);
  if (!header) {
    if (kvGet(tombFileKey(PERSONAL_TOMB, HEADER_PATH)) !== null)
      throw new Error("Protected vault records are damaged.");
    return null;
  }
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(authenticationHeaderWitness(header)),
  );
  return bytesToB64(new Uint8Array(digest));
}
export async function classifyExtensionPassword(password: string) {
  await initializeExtensionVault();
  const trap = await probeRetiredCredential(password, PERSONAL_TOMB);
  if (trap) {
    if (trap.response === "reject")
      throw new Error("The password did not open this vault.");
    return { realm: "synthetic" as const, trap };
  }
  await verifyCurrentCredential(PERSONAL_TOMB, password);
  return { realm: "real" as const };
}
