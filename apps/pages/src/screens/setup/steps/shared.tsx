/**
 * Shared pieces of the tabbed setup ceremony (ADR 0114): the chooser that
 * binds a capability family to a connector.
 *
 * A choice here writes `settings.v1` exactly the way Settings would — the
 * ceremony asks, the setting keeps. Nothing is staged for a later "save",
 * which is why skipping a step never has to undo anything.
 */

import { useState } from "react";
import {
  type CapabilityConnectorBinding,
  type CapabilityId,
  normalizeCapabilityConnectors,
} from "../../../lib/capabilities.js";
import { loadSettings, saveSettings } from "../../../lib/settings.js";
import "./steps.css";

/** The current binding for a capability family, and a chooser that persists. */
export function useCapabilityChoice(
  id: CapabilityId,
): [
  CapabilityConnectorBinding,
  (providerId: string, connectionId?: string) => void,
] {
  const [binding, setBinding] = useState(
    () =>
      normalizeCapabilityConnectors(loadSettings().capabilityConnectors)[id],
  );
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
    setBinding(next);
  };
  return [binding, choose];
}
