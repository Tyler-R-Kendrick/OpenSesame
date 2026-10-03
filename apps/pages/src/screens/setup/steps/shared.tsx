/**
 * Shared pieces of the tabbed setup ceremony (ADR 0114): the chooser that
 * binds a capability family to a connector.
 *
 * A choice is kept for the vault that is open. Switching vaults reads that
 * vault's bindings. Nothing is staged for a later "save", which is why
 * skipping a step never has to undo anything.
 */

import {
  type CapabilityConnectorBinding,
  type CapabilityId,
  normalizeCapabilityConnectors,
} from "@opensesame/app-core/lib/capabilities.js";
import { activeCapabilityVaultId } from "@opensesame/app-core/lib/capability-connector-scope.js";
import { subscribeProjects } from "@opensesame/app-core/lib/projects.js";
import {
  loadSettings,
  saveSettings,
  settingsEpoch,
  subscribeSettings,
} from "@opensesame/app-core/lib/settings.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { useState, useSyncExternalStore } from "react";
import "./steps.css";

function subscribeActiveVault(listener: () => void): () => void {
  const stopStore = vaultStore.subscribe(listener);
  const stopProjects = subscribeProjects(listener);
  return () => {
    stopStore();
    stopProjects();
  };
}

/** The open vault's binding for one capability family, and a chooser that persists. */
export function useCapabilityChoice(
  id: CapabilityId,
): [
  CapabilityConnectorBinding,
  (providerId: string, connectionId?: string) => void,
] {
  const epoch = useSyncExternalStore(
    subscribeSettings,
    settingsEpoch,
    settingsEpoch,
  );
  const tomb = useSyncExternalStore(
    subscribeActiveVault,
    activeCapabilityVaultId,
    activeCapabilityVaultId,
  );
  const stored = normalizeCapabilityConnectors(
    loadSettings().capabilityConnectors,
  )[id];
  const [picked, setPicked] = useState<{
    tomb: string;
    epoch: number;
    id: CapabilityId;
    binding: CapabilityConnectorBinding;
  } | null>(null);
  const binding =
    picked !== null &&
    picked.tomb === tomb &&
    picked.epoch === epoch &&
    picked.id === id
      ? picked.binding
      : stored;
  const choose = (providerId: string, connectionId?: string) => {
    const current = loadSettings();
    const map = normalizeCapabilityConnectors(current.capabilityConnectors);
    const previous = map[id];
    const next: CapabilityConnectorBinding = { providerId };
    if (connectionId?.trim()) {
      next.connectionId = connectionId.trim();
    } else if (previous.providerId === providerId && previous.connectionId) {
      next.connectionId = previous.connectionId;
    }
    if (previous.providerId === providerId && previous.remote) {
      next.remote = previous.remote;
    }
    saveSettings({
      ...current,
      capabilityConnectors: { ...map, [id]: next },
    });
    setPicked({ tomb, epoch, id, binding: next });
  };
  return [binding, choose];
}
