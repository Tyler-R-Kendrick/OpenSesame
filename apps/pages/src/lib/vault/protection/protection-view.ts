/**
 * View-model for Settings → Security → Vault key protection (C12).
 * Manifest is authority; capability preference is setup intent only.
 */

import type { CapabilityConnectorBinding } from "../../capabilities.js";
import type { VaultHeader } from "../crypto.js";
import {
  encryptionSetupIntentFromBinding,
  migrateLegacyHeaderToManifest,
} from "./migrate-legacy.js";
import type {
  EncryptionSetupIntent,
  ProtectionRecord,
  RootProtectionManifest,
} from "./types.js";

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

/** Honest labels for encryption preference provider ids — never "WebCrypto". */
export function preferenceMechanismLabel(providerId: string): string {
  switch (providerId) {
    case "webcrypto":
      return protectionMechanismLabel("password");
    case "fido2":
      return protectionMechanismLabel("webauthn-prf");
    case "yubikey":
      return protectionMechanismLabel("yubikey-piv-age");
    case "age":
      return protectionMechanismLabel("age-recipient");
    case "aws-kms":
      return protectionMechanismLabel("aws-kms");
    case "azure-key-vault-keys":
      return protectionMechanismLabel("azure-key-vault-keys");
    case "gcp-kms":
      return protectionMechanismLabel("gcp-kms");
    default:
      return providerId;
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

function providerHasEnrolledRecord(
  providerId: string,
  manifest: RootProtectionManifest | null,
): boolean {
  if (!manifest) return false;
  return manifest.records.some((record) => {
    switch (providerId) {
      case "aws-kms":
        return record.kind === "aws-kms";
      case "azure-key-vault-keys":
        return record.kind === "azure-key-vault-keys";
      case "gcp-kms":
        return record.kind === "gcp-kms";
      case "age":
        return (
          record.kind === "age-recipient" || record.kind === "age-webauthn"
        );
      case "fido2":
        return record.kind === "webauthn-prf";
      case "yubikey":
        return record.kind === "yubikey-piv-age";
      default:
        return false;
    }
  });
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

export function setupIntentForEncryptionBinding(
  binding: CapabilityConnectorBinding | undefined,
  manifest: RootProtectionManifest | null,
): EncryptionSetupIntent | null {
  if (!binding) return null;
  const enrolled = providerHasEnrolledRecord(binding.providerId, manifest)
    ? new Set([binding.providerId])
    : new Set<string>();
  return encryptionSetupIntentFromBinding(
    binding.providerId,
    binding.connectionId,
    enrolled,
  );
}

export type ProtectionViewState = {
  methods: ProtectorViewRow[];
  setupIntent: EncryptionSetupIntent | null;
  preferredProtectorId: string | null;
  /** False until BROWSER wires lifecycle mutations. */
  lifecycleReady: boolean;
};

/** Typed failure for lifecycle actions that are not wired yet. */
export class ProtectionNotWiredError extends Error {
  readonly code = "not_wired" as const;

  constructor(readonly action: string) {
    super(`not wired: ${action}`);
    this.name = "ProtectionNotWiredError";
  }
}

export const LIFECYCLE_NOT_READY_REASON =
  "Protection lifecycle is not ready on this build.";

/** Stubs for tests — throw typed not-wired. UI keeps controls disabled instead. */
export const protectionLifecycleStubs = {
  add(): never {
    throw new ProtectionNotWiredError("add");
  },
  test(_protectorId: string): never {
    throw new ProtectionNotWiredError("test");
  },
  preferred(_protectorId: string): never {
    throw new ProtectionNotWiredError("preferred");
  },
  remove(_protectorId: string): never {
    throw new ProtectionNotWiredError("remove");
  },
  rotateCompromised(): never {
    throw new ProtectionNotWiredError("rotate-compromised");
  },
} as const;

/**
 * Authority view: enrolled protectors from the (legacy-migrated) manifest,
 * plus encryption preference without a matching record as setup intent (KP-04).
 */
export function selectProtectionView(input: {
  header: VaultHeader | null | undefined;
  encryptionBinding?: CapabilityConnectorBinding;
  storedManifest?: RootProtectionManifest | null;
}): ProtectionViewState {
  const manifest = resolveProtectionManifest(
    input.header,
    input.storedManifest,
  );
  const methods = listProtectorViewRows(manifest);
  const setupIntent = setupIntentForEncryptionBinding(
    input.encryptionBinding,
    manifest,
  );
  return {
    methods,
    setupIntent,
    preferredProtectorId: manifest?.preferredProtectorId ?? null,
    lifecycleReady: true,
  };
}
