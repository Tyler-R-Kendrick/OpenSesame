/**
 * The catalog rows this app bundles, by id: the one list both the bundled
 * providers (`embedded-catalog.ts`) and the Connect catalog read, so a row
 * Pages already draws keeps its own road and Connect sits beside it.
 */
import parity from "../../../../spec/connectors/fnox-parity.json";
import {
  DEVICE_KEY_PROTECTORS,
  HOST_PROVIDER_IDS,
  IDENTITY_PROVIDER_IDS,
  LLM_PROVIDER_IDS,
  NETWORKING_PROVIDER_IDS,
  WALLET_PROVIDER_IDS,
} from "./embedded-catalog-data.js";
import { WALLET_ISSUER_IDS } from "./wallet-issuers.js";

const DEVICE: ReadonlySet<string> = new Set(DEVICE_KEY_PROTECTORS);

/** The generic git remote, drawn first and bundled on every device. */
export const BUNDLED_GIT_ID = "git";

/** Bundled catalog rows after `git`, in the order Connections draws them. */
export const BUNDLED_CATALOG_IDS: readonly string[] = [
  ...DEVICE_KEY_PROTECTORS,
  // fido2 is not a connector — WebAuthn PRF passkeys live under Unlock methods /
  // Vault key protection. Keep the fnox parity list intact; omit the row here.
  ...parity.providers.filter((id) => id !== "fido2" && !DEVICE.has(id)),
  ...HOST_PROVIDER_IDS,
  ...LLM_PROVIDER_IDS,
  ...IDENTITY_PROVIDER_IDS,
  ...NETWORKING_PROVIDER_IDS,
  ...WALLET_PROVIDER_IDS,
  ...WALLET_ISSUER_IDS,
];

let bundledIds: ReadonlySet<string> | null = null;

/** Whether Pages draws `id` from its own bundled catalog row. */
export function isBundledProviderId(id: string): boolean {
  bundledIds ??= new Set([BUNDLED_GIT_ID, ...BUNDLED_CATALOG_IDS]);
  return bundledIds.has(id);
}

/** Device key protectors are ready without setup. */
export function isDeviceKeyProtector(id: string): boolean {
  return DEVICE.has(id);
}
