/**
 * Per-connector local configuration — sealed in the tomb (ADR 0115).
 *
 * The directory names which integrations this device knows; that alone is
 * nobody else's business, so the settings that name them stay sealed beside
 * it. What a setting may hold is deliberately boring: a display alias, an
 * enabled switch, and the bind defaults the row's form opens with. Tokens
 * and credentials never appear here — connectors arrive by reference, and a
 * `GET /connection/{id}` is never called to fill one in.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { kvRefresh } from "./kv.js";
import { notifyLocalIamChange } from "./local-iam-events.js";
import { SHARE_DURATIONS, SHARE_POLICIES } from "./local-share-grants.js";
import { VfsError, readFile, tombFileKey, writeFile } from "./vfs.js";

export const CONNECTOR_SETTINGS_PATH = "config/connector-settings";
const MAX_BYTES = 64_000;
const MAX_ALIAS = 64;

export type ConnectorSetting = {
  /** Shown in place of the directory's display name. Empty means none. */
  alias: string;
  /** A disabled connector refuses new binds; its bindings read disabled. */
  enabled: boolean;
  /** Policy id the row's bind form opens with. */
  defaultPolicy: string;
  /** Duration in seconds the row's bind form opens with. */
  defaultDurationSeconds: number;
};

export const DEFAULT_CONNECTOR_SETTING: ConnectorSetting = {
  alias: "",
  enabled: true,
  defaultPolicy: SHARE_POLICIES.connection[0]?.id ?? "use",
  defaultDurationSeconds: SHARE_DURATIONS[0].seconds,
};

function isSetting(value: BoundaryValue): value is ConnectorSetting {
  if (!isJsonObject(value)) return false;
  if (!isString(value.alias) || value.alias.length > MAX_ALIAS) return false;
  if (typeof value.enabled !== "boolean") return false;
  if (
    !isString(value.defaultPolicy) ||
    !SHARE_POLICIES.connection.some((entry) => entry.id === value.defaultPolicy)
  )
    return false;
  if (
    typeof value.defaultDurationSeconds !== "number" ||
    !SHARE_DURATIONS.some(
      (entry) => entry.seconds === value.defaultDurationSeconds,
    )
  )
    return false;
  return true;
}

function parseRecord(value: BoundaryValue): Record<string, ConnectorSetting> {
  if (!isJsonObject(value)) return {};
  const out: Record<string, ConnectorSetting> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (key.length > 0 && key.length <= 128 && isSetting(entry))
      out[key] = entry;
  }
  return out;
}

/**
 * The sealed settings by share-grant resource id, or `{}` where none were
 * ever written. Throws `VfsError("locked")` before unlock.
 */
export async function readConnectorSettings(
  tomb: string,
): Promise<Record<string, ConnectorSetting>> {
  await kvRefresh(tombFileKey(tomb, CONNECTOR_SETTINGS_PATH), MAX_BYTES * 2);
  try {
    const bytes = await readFile(tomb, CONNECTOR_SETTINGS_PATH);
    if (bytes.length > MAX_BYTES) return {};
    const parsed: BoundaryValue = JSON.parse(new TextDecoder().decode(bytes));
    return parseRecord(parsed);
  } catch (error) {
    if (error instanceof VfsError && error.code === "not-found") return {};
    throw error;
  }
}

/**
 * Seal one connector's settings. A setting back at the defaults is deleted
 * instead of stored, so the record only names connectors someone configured.
 */
export async function writeConnectorSetting(
  tomb: string,
  resourceId: string,
  setting: ConnectorSetting,
): Promise<void> {
  if (!isSetting({ ...setting, alias: setting.alias.trim() })) {
    throw new Error("That connector setting is not valid.");
  }
  const trimmed = { ...setting, alias: setting.alias.trim() };
  const current = await readConnectorSettings(tomb);
  const fresh = { ...current };
  const isDefault =
    trimmed.alias === "" &&
    trimmed.enabled === true &&
    trimmed.defaultPolicy === DEFAULT_CONNECTOR_SETTING.defaultPolicy &&
    trimmed.defaultDurationSeconds ===
      DEFAULT_CONNECTOR_SETTING.defaultDurationSeconds;
  if (isDefault) delete fresh[resourceId];
  else fresh[resourceId] = trimmed;
  const bytes = new TextEncoder().encode(JSON.stringify(fresh));
  if (bytes.length > MAX_BYTES) {
    throw new Error("Too many connector settings to keep here.");
  }
  try {
    await writeFile(tomb, CONNECTOR_SETTINGS_PATH, bytes);
  } finally {
    notifyLocalIamChange();
  }
}

/** The effective setting: what was sealed, or the defaults where nothing was. */
export function settingFor(
  all: Record<string, ConnectorSetting>,
  resourceId: string,
): ConnectorSetting {
  return all[resourceId] ?? DEFAULT_CONNECTOR_SETTING;
}
