/**
 * Shared pieces of the tabbed setup ceremony (ADR 0114): the per-step
 * heading, and the chooser that binds a capability family to a connector.
 *
 * A choice here writes `settings.v1` exactly the way Settings would — the
 * ceremony asks the question, the setting keeps the answer. Nothing is
 * staged for a later "save", which is why skipping a step never has to
 * undo anything.
 */

import { type ReactNode, useState } from "react";
import {
  type CapabilityConnectorBinding,
  type CapabilityId,
  normalizeCapabilityConnectors,
} from "../../../lib/capabilities.js";
import { loadSettings, saveSettings } from "../../../lib/settings.js";
import "./steps.css";

/** One step's question and the line that says what answering buys. */
export function StepHead({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="setup__head">
      <h1>{title}</h1>
      <p>{children}</p>
    </div>
  );
}

/** The current binding for a capability family, and a chooser that persists. */
export function useCapabilityChoice(
  id: CapabilityId,
): [CapabilityConnectorBinding, (providerId: string) => void] {
  const [binding, setBinding] = useState(
    () =>
      normalizeCapabilityConnectors(loadSettings().capabilityConnectors)[id],
  );
  const choose = (providerId: string) => {
    const current = loadSettings();
    const map = normalizeCapabilityConnectors(current.capabilityConnectors);
    saveSettings({
      ...current,
      capabilityConnectors: { ...map, [id]: { providerId } },
    });
    setBinding({ providerId });
  };
  return [binding, choose];
}
