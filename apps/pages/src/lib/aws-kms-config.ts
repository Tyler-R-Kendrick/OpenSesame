/**
 * Browser-local AWS KMS connector config.
 *
 * Seals the key ARN and SigV4 credentials in the vault so Settings ›
 * Connections › AWS KMS works without a Host (ADR 0090).
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { assertAwsKmsKeyArn } from "./vault/protection/adapters/aws-kms.js";
import { VfsError, deleteFile, readFile, writeFile } from "./vfs.js";

export const AWS_KMS_CONFIG_PATH = "config/aws-kms";

export type AwsKmsDeviceConfig = {
  keyArn: string;
  region: string;
  accessKeyId: string;
  /** Sealed secret — never shown again after save. */
  secretAccessKey: string;
  sessionToken: string | null;
  label: string | null;
  /** Bumps on every successful write so protectors can pin a config version. */
  configVersion: string;
};

/** What the UI may show after credentials are sealed. */
export type AwsKmsDevicePublic = {
  keyArn: string;
  region: string;
  accessKeyId: string;
  hasSecret: boolean;
  hasSessionToken: boolean;
  label: string | null;
  configVersion: string;
};

const EMPTY: AwsKmsDeviceConfig = {
  keyArn: "",
  region: "",
  accessKeyId: "",
  secretAccessKey: "",
  sessionToken: null,
  label: null,
  configVersion: "0",
};

function isAccessKeyId(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed.length < 16 || trimmed.length > 128) return false;
  return /^[A-Z0-9]+$/i.test(trimmed);
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

function parseConfig(value: BoundaryValue): AwsKmsDeviceConfig {
  if (!isJsonObject(value)) return EMPTY;
  const keyArn = requiredTrimmed(value, "keyArn");
  const accessKeyId = requiredTrimmed(value, "accessKeyId");
  const secretAccessKey = isString(value.secretAccessKey)
    ? value.secretAccessKey
    : "";
  if (!keyArn || !accessKeyId || !secretAccessKey) return EMPTY;
  if (!isAccessKeyId(accessKeyId)) return EMPTY;
  let identity: { keyArn: string; region: string };
  try {
    identity = assertAwsKmsKeyArn(keyArn);
  } catch {
    return EMPTY;
  }
  return {
    keyArn: identity.keyArn,
    region: optionalTrimmed(value, "region") ?? identity.region,
    accessKeyId,
    secretAccessKey,
    sessionToken: optionalTrimmed(value, "sessionToken"),
    label: optionalTrimmed(value, "label"),
    configVersion: optionalTrimmed(value, "configVersion") ?? "1",
  };
}

export function toAwsKmsPublic(config: AwsKmsDeviceConfig): AwsKmsDevicePublic {
  return {
    keyArn: config.keyArn,
    region: config.region,
    accessKeyId: config.accessKeyId,
    hasSecret: config.secretAccessKey.length > 0,
    hasSessionToken: Boolean(config.sessionToken),
    label: config.label,
    configVersion: config.configVersion,
  };
}

export async function readAwsKmsConfig(
  tomb: string,
): Promise<AwsKmsDeviceConfig> {
  try {
    const bytes = await readFile(tomb, AWS_KMS_CONFIG_PATH);
    const parsed: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
    return parseConfig(parsed);
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return EMPTY;
    throw error;
  }
}

export async function writeAwsKmsConfig(
  tomb: string,
  input: {
    keyArn: string;
    region?: string | null;
    accessKeyId: string;
    secretAccessKey: string;
    sessionToken?: string | null;
    label?: string | null;
    /** When set and the secret field is empty, keep the previously sealed secret. */
    keepExistingSecret?: boolean;
  },
): Promise<AwsKmsDeviceConfig> {
  const previous = await readAwsKmsConfig(tomb);
  const keyArn = input.keyArn.trim();
  const identity = assertAwsKmsKeyArn(keyArn);
  const accessKeyId = input.accessKeyId.trim();
  if (!isAccessKeyId(accessKeyId)) {
    throw new Error("Paste an AWS access key ID (AKIA… or ASIA…).");
  }
  let secretAccessKey = input.secretAccessKey;
  if (!secretAccessKey.trim()) {
    if (input.keepExistingSecret && previous.secretAccessKey) {
      secretAccessKey = previous.secretAccessKey;
    } else {
      throw new Error("Paste the AWS secret access key once.");
    }
  }
  const region = input.region?.trim() || identity.region;
  if (region !== identity.region) {
    throw new Error("Region must match the key ARN.");
  }
  const next: AwsKmsDeviceConfig = {
    keyArn: identity.keyArn,
    region,
    accessKeyId,
    secretAccessKey,
    sessionToken: input.sessionToken?.trim() ? input.sessionToken.trim() : null,
    label: input.label?.trim() ? input.label.trim() : null,
    configVersion: String(Number(previous.configVersion || "0") + 1),
  };
  await writeFile(
    tomb,
    AWS_KMS_CONFIG_PATH,
    new TextEncoder().encode(JSON.stringify(next)),
  );
  return next;
}

export async function clearAwsKmsConfig(tomb: string): Promise<void> {
  try {
    await deleteFile(tomb, AWS_KMS_CONFIG_PATH);
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return;
    throw error;
  }
}
