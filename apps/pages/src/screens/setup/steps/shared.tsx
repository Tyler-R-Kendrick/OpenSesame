/**
 * Shared pieces of the tabbed setup ceremony (ADR 0114): the per-step
 * heading, and a chooser that binds a capability family to a connector.
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
  capabilityDef,
  connectorLabel,
  normalizeCapabilityConnectors,
} from "../../../lib/capabilities.js";
import { loadSettings, saveSettings } from "../../../lib/settings.js";

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

/** A capability family's connectors as a two-up grid of real choices. */
export function CapabilityChoices({ id }: { id: CapabilityId }) {
  const def = capabilityDef(id);
  const [binding, choose] = useCapabilityChoice(id);
  return (
    <div className="preset" aria-label={def.title}>
      {def.connectorIds.map((providerId) => (
        <button
          key={providerId}
          type="button"
          className={`preset__opt${binding.providerId === providerId ? " is-on" : ""}`}
          aria-pressed={binding.providerId === providerId}
          onClick={() => choose(providerId)}
        >
          <span className="preset__name">{connectorLabel(providerId)}</span>
          <span className="preset__kind">
            {def.requiresAuth(providerId)
              ? "authorize once sealed"
              : "no account needed"}
          </span>
        </button>
      ))}
    </div>
  );
}
