/**
 * Capability → connector bindings belong to one vault.
 *
 * `settings.v1` used to keep a single `capabilityConnectors` map for the
 * whole device. A legacy record with no per-vault map still belongs to the
 * personal tomb. Every other tomb, including guest, starts from the defaults.
 * An empty `capabilityConnectorsByVault` object is already per-vault: a
 * missing tomb is the defaults, not the legacy map.
 */

import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import {
  type CapabilityConnectorBinding,
  type CapabilityConnectorMap,
  type CapabilityId,
  type HistoryBackupSelection,
  defaultCapabilityConnectors,
  normalizeCapabilityConnectors,
} from "./capabilities.js";
import { kvGet } from "./kv.js";
import { lastVaultIsGuest } from "./last-vault.js";
import { PERSONAL_PROJECT_ID, readBootActiveId } from "./projects-state.js";
import { GUEST_TOMB } from "./vfs.js";

export const SETTINGS_PERSIST_KEY = "settings.v1";

/** The tomb whose bindings `loadSettings().capabilityConnectors` returns. */
export function activeCapabilityVaultId(): string {
  return lastVaultIsGuest() ? GUEST_TOMB : readBootActiveId();
}

interface ScopedCapabilityConnectors {
  readonly capabilityConnectors: CapabilityConnectorMap;
  readonly capabilityConnectorsByVault: Record<string, CapabilityConnectorMap>;
}

export function bindingsFromStored(
  parsed: JsonObject,
): ScopedCapabilityConnectors {
  const byVault = parsed.capabilityConnectorsByVault;
  return {
    capabilityConnectors: connectorsForActiveVault(parsed),
    capabilityConnectorsByVault: isJsonObject(byVault)
      ? storedVaultMaps(byVault)
      : {},
  };
}

export function scopeCapabilityConnectorsForSave(
  activeMap: CapabilityConnectorMap | undefined,
): ScopedCapabilityConnectors {
  const mine = normalizeCapabilityConnectors(activeMap);
  const maps = mapsForSave(readRawSettings());
  maps[activeCapabilityVaultId()] = mine;
  return { capabilityConnectors: mine, capabilityConnectorsByVault: maps };
}

function connectorsForActiveVault(parsed: JsonObject): CapabilityConnectorMap {
  const byVault = parsed.capabilityConnectorsByVault;
  const active = activeCapabilityVaultId();
  if (!isJsonObject(byVault)) {
    if (active !== PERSONAL_PROJECT_ID) return defaultCapabilityConnectors();
    return normalizedSlot(parsed.capabilityConnectors);
  }
  const slot = byVault[active];
  return isJsonObject(slot)
    ? normalizedSlot(slot)
    : defaultCapabilityConnectors();
}

function mapsForSave(parsed: JsonObject | undefined) {
  const byVault = parsed?.capabilityConnectorsByVault;
  if (isJsonObject(byVault)) return storedVaultMaps(byVault);
  const maps: Record<string, CapabilityConnectorMap> = {};
  maps[PERSONAL_PROJECT_ID] = normalizedSlot(parsed?.capabilityConnectors);
  return maps;
}

function storedVaultMaps(
  byVault: JsonObject,
): Record<string, CapabilityConnectorMap> {
  const maps: Record<string, CapabilityConnectorMap> = Object.create(null);
  for (const [id, slot] of Object.entries(byVault)) {
    if (!isVaultId(id) || !isJsonObject(slot)) continue;
    maps[id] = normalizedSlot(slot);
  }
  return maps;
}

function normalizedSlot(value: JsonValue | undefined): CapabilityConnectorMap {
  return normalizeCapabilityConnectors(
    isJsonObject(value) ? readCapabilityConnectors(value) : undefined,
  );
}

function isVaultId(id: string): boolean {
  return (
    id.length > 0 &&
    id.length <= 128 &&
    id !== "__proto__" &&
    id !== "constructor" &&
    id !== "prototype"
  );
}

function readRawSettings(): JsonObject | undefined {
  const raw = kvGet(SETTINGS_PERSIST_KEY);
  if (!raw) return undefined;
  try {
    const parsed: BoundaryValue = JSON.parse(raw);
    return isJsonObject(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function readCapabilityConnectors(value: JsonObject) {
  const connectors: Partial<
    Record<CapabilityId, Partial<CapabilityConnectorBinding>>
  > = {};
  for (const id of ["encryption", "history"] as const) {
    const candidate = value[id];
    if (!isJsonObject(candidate)) continue;
    const binding: Partial<CapabilityConnectorBinding> = {};
    if (isString(candidate.providerId)) {
      binding.providerId = candidate.providerId;
    }
    if (isString(candidate.connectionId)) {
      binding.connectionId = candidate.connectionId;
    }
    if (isString(candidate.remote)) {
      binding.remote = candidate.remote;
    }
    if (id === "history" && Array.isArray(candidate.selections)) {
      binding.selections = candidate.selections
        .filter(isJsonObject)
        .map((row) => {
          const selection: HistoryBackupSelection = {
            providerId: isString(row.providerId) ? row.providerId : "",
            group: row.group === "postgres" ? "postgres" : "git",
          };
          if (isString(row.connectionId)) {
            selection.connectionId = row.connectionId;
          }
          if (isString(row.remote)) selection.remote = row.remote;
          if (
            row.claimState === "provisional" ||
            row.claimState === "claimed"
          ) {
            selection.claimState = row.claimState;
          }
          if (isString(row.provisionalAccountId)) {
            selection.provisionalAccountId = row.provisionalAccountId;
          }
          return selection;
        })
        .filter((row) => row.providerId.length > 0);
    }
    connectors[id] = binding;
  }
  return connectors;
}
