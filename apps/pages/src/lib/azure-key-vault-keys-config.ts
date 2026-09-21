/**
 * Browser-local Azure Key Vault Keys connector config.
 *
 * Seals the versioned key id and service-principal credentials in the vault
 * so Settings › Connections › Azure Key Vault Keys works without a Host
 * (ADR 0090).
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { assertAzureVersionedKeyId } from "./vault/protection/adapters/azure-key-vault-keys.js";
import { VfsError, deleteFile, readFile, writeFile } from "./vfs.js";

export const AZURE_KEY_VAULT_KEYS_CONFIG_PATH = "config/azure-key-vault-keys";

export type AzureKeyVaultKeysDeviceConfig = {
  versionedKeyId: string;
  tenantId: string;
  clientId: string;
  /** Sealed secret — never shown again after save. */
  clientSecret: string;
  label: string | null;
  /** Bumps on every successful write so protectors can pin a config version. */
  configVersion: string;
};

/** What the UI may show after credentials are sealed. */
export type AzureKeyVaultKeysDevicePublic = {
  versionedKeyId: string;
  tenantId: string;
  clientId: string;
  hasSecret: boolean;
  label: string | null;
  configVersion: string;
};

const EMPTY: AzureKeyVaultKeysDeviceConfig = {
  versionedKeyId: "",
  tenantId: "",
  clientId: "",
  clientSecret: "",
  label: null,
  configVersion: "0",
};

const GUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function isGuid(value: string): boolean {
  return GUID_RE.test(value.trim());
}

function optionalTrimmed(value: BoundaryValue, key: string): string | null {
  if (!isJsonObject(value)) return null;
  const raw = value[key];
  if (!isString(raw)) return null;
  const trimmed = raw.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function requiredTrimmed(value: BoundaryValue, key: string): string {
  return optionalTrimmed(value, key) ?? "";
}

function parseConfig(value: BoundaryValue): AzureKeyVaultKeysDeviceConfig {
  if (!isJsonObject(value)) return EMPTY;
  const versionedKeyId = requiredTrimmed(value, "versionedKeyId");
  const tenantId = requiredTrimmed(value, "tenantId");
  const clientId = requiredTrimmed(value, "clientId");
  const clientSecret = isString(value.clientSecret) ? value.clientSecret : "";
  if (!versionedKeyId || !tenantId || !clientId || !clientSecret) return EMPTY;
  if (!isGuid(tenantId) || !isGuid(clientId)) return EMPTY;
  try {
    assertAzureVersionedKeyId(versionedKeyId);
  } catch {
    return EMPTY;
  }
  return {
    versionedKeyId,
    tenantId,
    clientId,
    clientSecret,
    label: optionalTrimmed(value, "label"),
    configVersion: optionalTrimmed(value, "configVersion") ?? "1",
  };
}

export function toAzureKeyVaultKeysPublic(
  config: AzureKeyVaultKeysDeviceConfig,
): AzureKeyVaultKeysDevicePublic {
  return {
    versionedKeyId: config.versionedKeyId,
    tenantId: config.tenantId,
    clientId: config.clientId,
    hasSecret: config.clientSecret.length > 0,
    label: config.label,
    configVersion: config.configVersion,
  };
}

export async function readAzureKeyVaultKeysConfig(
  tomb: string,
): Promise<AzureKeyVaultKeysDeviceConfig> {
  try {
    const bytes = await readFile(tomb, AZURE_KEY_VAULT_KEYS_CONFIG_PATH);
    const parsed: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
    return parseConfig(parsed);
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return EMPTY;
    throw error;
  }
}

export async function writeAzureKeyVaultKeysConfig(
  tomb: string,
  input: {
    versionedKeyId: string;
    tenantId: string;
    clientId: string;
    clientSecret: string;
    label?: string | null;
    keepExistingSecret?: boolean;
  },
): Promise<AzureKeyVaultKeysDeviceConfig> {
  const previous = await readAzureKeyVaultKeysConfig(tomb);
  const versionedKeyId = input.versionedKeyId.trim();
  assertAzureVersionedKeyId(versionedKeyId);
  const tenantId = input.tenantId.trim();
  const clientId = input.clientId.trim();
  if (!isGuid(tenantId)) {
    throw new Error("Paste the Azure tenant (directory) ID.");
  }
  if (!isGuid(clientId)) {
    throw new Error("Paste the Azure application (client) ID.");
  }
  let clientSecret = input.clientSecret;
  if (!clientSecret.trim()) {
    if (input.keepExistingSecret && previous.clientSecret) {
      clientSecret = previous.clientSecret;
    } else {
      throw new Error("Paste the Azure client secret once.");
    }
  }
  const next: AzureKeyVaultKeysDeviceConfig = {
    versionedKeyId,
    tenantId,
    clientId,
    clientSecret,
    label: input.label?.trim() ? input.label.trim() : null,
    configVersion: String(Number(previous.configVersion || "0") + 1),
  };
  await writeFile(
    tomb,
    AZURE_KEY_VAULT_KEYS_CONFIG_PATH,
    new TextEncoder().encode(JSON.stringify(next)),
  );
  return next;
}

export async function clearAzureKeyVaultKeysConfig(
  tomb: string,
): Promise<void> {
  try {
    await deleteFile(tomb, AZURE_KEY_VAULT_KEYS_CONFIG_PATH);
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return;
    throw error;
  }
}
