/**
 * Purpose cards — the presets, rendered from data (`PRESETS`).
 *
 * Choosing one is a preview: the draft takes the preset's default roots and
 * nothing is applied until the review's Apply. The card's text is a choice
 * object (a purpose), which is why it may carry words.
 */

import type { CapabilityPreset } from "@opensesame/app-core/lib/configuration/capabilities-ports.js";

export function PurposeCards({
  presets,
  chosen,
  onChoose,
}: {
  presets: readonly CapabilityPreset[];
  chosen: string | null;
  onChoose: (preset: CapabilityPreset) => void;
}) {
  return (
    <ul className="purpose" aria-label="Purpose">
      {presets.map((preset) => {
        const on = chosen === preset.id;
        return (
          <li key={preset.id}>
            <button
              type="button"
              className={`preset__opt${on ? " is-on" : ""}`}
              aria-pressed={on}
              data-testid={`purpose-card-${preset.id}`}
              onClick={() => onChoose(preset)}
            >
              <span className="preset__name">{preset.title}</span>
              <span className="preset__kind">{preset.summary}</span>
              <span className="preset__kind">
                {`${preset.required.length} required · ${preset.optional.length} optional`}
              </span>
            </button>
          </li>
        );
      })}
    </ul>
  );
}
