/**
 * Browser-local YubiKey PIV connector config.
 *
 * The private key stays on the hardware. This store keeps the public age
 * recipient (and optional slot / serial) so Settings › Connections › YubiKey
 * can bind encryption preference without a Host.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { VfsError, deleteFile, readFile, writeFile } from "./vfs.js";

export const YUBIKEY_CONFIG_PATH = "config/yubikey";

export type YubikeyDeviceConfig = {
  /** Public age-plugin-yubikey recipient (`age1yubikey…`). */
  recipient: string;
  /** PIV slot, when known (for example `9a`). */
  slot: string | null;
  /** Optional serial printed on the key. */
  serialHint: string | null;
  /** Display label for this device on the connector page. */
  label: string | null;
};

const EMPTY: YubikeyDeviceConfig = {
  recipient: "",
  slot: null,
  serialHint: null,
  label: null,
};

/** True when `line` looks like an age-plugin-yubikey recipient. */
export function isYubikeyAgeRecipient(line: string): boolean {
  const trimmed = line.trim().toLowerCase();
  if (!trimmed.startsWith("age1yubikey")) return false;
  if (trimmed.length < 20 || trimmed.length > 256) return false;
  for (const char of trimmed) {
    const code = char.codePointAt(0) ?? 0;
    if (!((code >= 97 && code <= 122) || (code >= 48 && code <= 57))) {
      return false;
    }
  }
  return true;
}

function parseConfig(value: BoundaryValue): YubikeyDeviceConfig {
  if (!isJsonObject(value)) return EMPTY;
  const recipient = isString(value.recipient) ? value.recipient.trim() : "";
  const slot =
    isString(value.slot) && value.slot.trim().length > 0
      ? value.slot.trim()
      : null;
  const serialHint =
    isString(value.serialHint) && value.serialHint.trim().length > 0
      ? value.serialHint.trim()
      : null;
  const label =
    isString(value.label) && value.label.trim().length > 0
      ? value.label.trim()
      : null;
  if (!recipient || !isYubikeyAgeRecipient(recipient)) {
    return EMPTY;
  }
  return { recipient, slot, serialHint, label };
}

export async function readYubikeyConfig(
  tomb: string,
): Promise<YubikeyDeviceConfig> {
  try {
    const bytes = await readFile(tomb, YUBIKEY_CONFIG_PATH);
    const parsed: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
    return parseConfig(parsed);
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return EMPTY;
    throw error;
  }
}

export async function writeYubikeyConfig(
  tomb: string,
  input: {
    recipient: string;
    slot?: string | null;
    serialHint?: string | null;
    label?: string | null;
  },
): Promise<YubikeyDeviceConfig> {
  const recipient = input.recipient.trim();
  if (!isYubikeyAgeRecipient(recipient)) {
    throw new Error("Paste an age1yubikey… recipient from age-plugin-yubikey.");
  }
  const next: YubikeyDeviceConfig = {
    recipient,
    slot: input.slot?.trim() ? input.slot.trim() : null,
    serialHint: input.serialHint?.trim() ? input.serialHint.trim() : null,
    label: input.label?.trim() ? input.label.trim() : null,
  };
  await writeFile(
    tomb,
    YUBIKEY_CONFIG_PATH,
    new TextEncoder().encode(JSON.stringify(next)),
  );
  return next;
}

export async function clearYubikeyConfig(tomb: string): Promise<void> {
  try {
    await deleteFile(tomb, YUBIKEY_CONFIG_PATH);
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return;
    throw error;
  }
}
