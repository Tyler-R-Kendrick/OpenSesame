/**
 * View-model for Settings → Security → Vault key protection (C12).
 * The header's manifest is the authority: a row is an enrolled protector.
 */

import type {
  ProtectionRecord,
  RootProtectionManifest,
  VaultHeader,
} from "@opensesame/vault-core";
import { migrateLegacyHeaderToManifest } from "./migrate-legacy.js";

export type ProtectorViewRow = {
  protectorId: string;
  kind: ProtectionRecord["kind"];
  /** Mechanism label — never "WebCrypto". */
  mechanismLabel: string;
  identityLabel: string;
  proofStatus: ProtectionRecord["proofStatus"];
  legacy: boolean;
  currentlyListed: true;
};

export function protectionMechanismLabel(
  kind: ProtectionRecord["kind"],
): string {
  switch (kind) {
    case "password":
      return "Password";
    case "pin":
      return "PIN";
    case "webauthn-prf":
      return "Passkey / security key";
    case "age-recipient":
      return "age recipient";
    case "age-webauthn":
      return "age passkey";
    case "yubikey-piv-age":
      return "YubiKey PIV through age";
    case "recovery-key":
      return "Recovery key";
    case "aws-kms":
      return "AWS KMS";
    case "azure-key-vault-keys":
      return "Azure Key Vault Keys";
    case "gcp-kms":
      return "Google Cloud KMS";
    case "device-local":
      return "Device-local key";
    default: {
      const _exhaustive: never = kind;
      return _exhaustive;
    }
  }
}

function identityLabel(record: ProtectionRecord): string {
  switch (record.kind) {
    case "password":
      return "Password wrap";
    case "pin":
      return "PIN wrap";
    case "webauthn-prf":
      return record.credentialIdB64.slice(0, 12);
    case "age-recipient":
      return record.recipients.join(", ");
    case "age-webauthn":
    case "yubikey-piv-age":
      return record.recipient;
    case "recovery-key":
      return record.fingerprintB64;
    case "aws-kms":
      return record.keyArn;
    case "azure-key-vault-keys":
      return record.versionedKeyId;
    case "gcp-kms":
      return record.keyName;
    case "device-local":
      return record.mechanism;
    default: {
      const _exhaustive: never = record;
      return _exhaustive;
    }
  }
}

export function resolveProtectionManifest(
  header: VaultHeader | null | undefined,
  stored?: RootProtectionManifest | null,
): RootProtectionManifest | null {
  if (stored) return stored;
  if (!header) return null;
  return migrateLegacyHeaderToManifest({ header }).manifest;
}

export function listProtectorViewRows(
  manifest: RootProtectionManifest | null,
): ProtectorViewRow[] {
  if (!manifest) return [];
  return manifest.records.map((record) => ({
    protectorId: record.protectorId,
    kind: record.kind,
    mechanismLabel: protectionMechanismLabel(record.kind),
    identityLabel: identityLabel(record),
    proofStatus: record.proofStatus,
    legacy: "legacy" in record ? record.legacy === true : false,
    currentlyListed: true,
  }));
}

export type ProtectionViewState = {
  methods: ProtectorViewRow[];
  preferredProtectorId: string | null;
  /** False until BROWSER wires lifecycle mutations. */
  lifecycleReady: boolean;
};

/**
 * Authority view: enrolled protectors from the header's sealed manifest —
 * the same one the lifecycle service reads, so a row's id is an id the service
 * knows — else the legacy wraps projected in memory. A saved encryption
 * preference is not a row: only an enrolled protector is (KP-04).
 *
 * The in-memory projection mints fresh ids on every call. It is only ever a
 * read-only stand-in for a header that has not been projected yet (a locked
 * vault); acting on one of its rows would name a protector no manifest holds.
 */
export function selectProtectionView(input: {
  header: VaultHeader | null | undefined;
  storedManifest?: RootProtectionManifest | null;
}): ProtectionViewState {
  const manifest = resolveProtectionManifest(
    input.header,
    input.storedManifest ?? input.header?.protection,
  );
  const methods = listProtectorViewRows(manifest);
  return {
    methods,
    preferredProtectorId: manifest?.preferredProtectorId ?? null,
    lifecycleReady: true,
  };
}
