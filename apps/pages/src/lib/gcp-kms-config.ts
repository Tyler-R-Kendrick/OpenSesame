/**
 * Browser-local GCP KMS connector config.
 *
 * Seals the crypto-key name and service-account JSON in the vault so
 * Settings › Connections › Google Cloud KMS works without a Host (ADR 0090).
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { assertGcpCryptoKeyName } from "./vault/protection/adapters/gcp-kms.js";
import { VfsError, deleteFile, readFile, writeFile } from "./vfs.js";

export const GCP_KMS_CONFIG_PATH = "config/gcp-kms";

export type GcpKmsDeviceConfig = {
  keyName: string;
  projectId: string;
  /** Sealed service-account JSON — never shown again after save. */
  serviceAccountJson: string;
  label: string | null;
  /** Bumps on every successful write so protectors can pin a config version. */
  configVersion: string;
};

/** What the UI may show after credentials are sealed. */
export type GcpKmsDevicePublic = {
  keyName: string;
  projectId: string;
  hasSecret: boolean;
  label: string | null;
  configVersion: string;
};

const EMPTY: GcpKmsDeviceConfig = {
  keyName: "",
  projectId: "",
  serviceAccountJson: "",
  label: null,
  configVersion: "0",
};

const PROJECT_FROM_KEY = /^projects\/([a-z0-9-]+)\/locations\//i;

function projectIdFromKeyName(keyName: string): string | null {
  const match = PROJECT_FROM_KEY.exec(keyName.trim());
  return match?.[1] ?? null;
}

function assertServiceAccountJson(raw: string): string {
  let parsed: BoundaryValue;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error("Paste a complete service-account JSON credential.");
  }
  if (!isJsonObject(parsed) || !isString(parsed.client_email)) {
    throw new Error("Service-account JSON must include client_email.");
  }
  return raw.trim();
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

function parseConfig(value: BoundaryValue): GcpKmsDeviceConfig {
  if (!isJsonObject(value)) return EMPTY;
  const keyName = requiredTrimmed(value, "keyName");
  const serviceAccountJson = isString(value.serviceAccountJson)
    ? value.serviceAccountJson
    : "";
  if (!keyName || !serviceAccountJson) return EMPTY;
  try {
    assertGcpCryptoKeyName(keyName);
    assertServiceAccountJson(serviceAccountJson);
  } catch {
    return EMPTY;
  }
  const derived = projectIdFromKeyName(keyName) ?? "";
  const projectId = optionalTrimmed(value, "projectId") ?? derived;
  if (!projectId || (derived && projectId !== derived)) return EMPTY;
  return {
    keyName,
    projectId,
    serviceAccountJson,
    label: optionalTrimmed(value, "label"),
    configVersion: optionalTrimmed(value, "configVersion") ?? "1",
  };
}

export function toGcpKmsPublic(config: GcpKmsDeviceConfig): GcpKmsDevicePublic {
  return {
    keyName: config.keyName,
    projectId: config.projectId,
    hasSecret: config.serviceAccountJson.length > 0,
    label: config.label,
    configVersion: config.configVersion,
  };
}

export async function readGcpKmsConfig(
  tomb: string,
): Promise<GcpKmsDeviceConfig> {
  try {
    const bytes = await readFile(tomb, GCP_KMS_CONFIG_PATH);
    const parsed: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
    return parseConfig(parsed);
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return EMPTY;
    throw error;
  }
}

export async function writeGcpKmsConfig(
  tomb: string,
  input: {
    keyName: string;
    projectId?: string | null;
    serviceAccountJson: string;
    label?: string | null;
    keepExistingSecret?: boolean;
  },
): Promise<GcpKmsDeviceConfig> {
  const previous = await readGcpKmsConfig(tomb);
  const keyName = input.keyName.trim();
  assertGcpCryptoKeyName(keyName);
  const derived = projectIdFromKeyName(keyName);
  if (!derived) {
    throw new Error("Paste a full projects/…/cryptoKeys/… key name.");
  }
  const projectId = input.projectId?.trim() || derived;
  if (projectId !== derived) {
    throw new Error("Project ID must match the crypto key name.");
  }
  let serviceAccountJson = input.serviceAccountJson;
  if (!serviceAccountJson.trim()) {
    if (input.keepExistingSecret && previous.serviceAccountJson) {
      serviceAccountJson = previous.serviceAccountJson;
    } else {
      throw new Error("Paste the service-account JSON once.");
    }
  }
  serviceAccountJson = assertServiceAccountJson(serviceAccountJson);
  const next: GcpKmsDeviceConfig = {
    keyName,
    projectId,
    serviceAccountJson,
    label: input.label?.trim() ? input.label.trim() : null,
    configVersion: String(Number(previous.configVersion || "0") + 1),
  };
  await writeFile(
    tomb,
    GCP_KMS_CONFIG_PATH,
    new TextEncoder().encode(JSON.stringify(next)),
  );
  return next;
}

export async function clearGcpKmsConfig(tomb: string): Promise<void> {
  try {
    await deleteFile(tomb, GCP_KMS_CONFIG_PATH);
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return;
    throw error;
  }
}
