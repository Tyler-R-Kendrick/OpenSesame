import {
  PRESET_CATALOG,
  planRecipient,
} from "@opensesame/app-core/lib/duress/settings/index.js";
import type { PresetId } from "@opensesame/app-core/lib/duress/settings/index.js";
import { isPresetId } from "@opensesame/app-core/lib/duress/settings/presets.js";
import type { DuressEnrollmentViewModel } from "./useDuressEnrollmentPanel.js";

export function DuressEnrollmentModeSection({
  vm,
}: {
  vm: DuressEnrollmentViewModel;
}) {
  const {
    setMode,
    setPresetId,
    setAdvancedJson,
    mode,
    presetId,
    advancedJson,
    preset,
  } = vm;
  return (
    <>
      <div
        role="tablist"
        aria-label="Duress editor mode"
        className="duress-enroll__tabs"
      >
        <button
          type="button"
          role="tab"
          id="duress-mode-preset"
          aria-selected={mode === "preset"}
          onClick={() => setMode("preset")}
        >
          Presets
        </button>
        <button
          type="button"
          role="tab"
          id="duress-mode-advanced"
          aria-selected={mode === "advanced"}
          onClick={() => setMode("advanced")}
        >
          Advanced
        </button>
      </div>

      {mode === "preset" ? (
        <fieldset className="duress-enroll__preset">
          <legend className="sr-only">Preset</legend>
          <label htmlFor="duress-preset-select">Preset</label>
          <select
            id="duress-preset-select"
            value={presetId}
            onChange={(e) => {
              const next = e.currentTarget.value;
              if (isPresetId(next)) setPresetId(next);
            }}
          >
            {PRESET_CATALOG.map((p) => (
              <option key={p.id} value={p.id}>
                {p.title}
              </option>
            ))}
          </select>
          <p>{preset.summary}</p>
          <p className="duress-enroll__limit">{preset.honestLimit}</p>
        </fieldset>
      ) : (
        <label className="duress-enroll__advanced">
          Advanced multi-profile JSON
          <textarea
            value={advancedJson}
            onChange={(e) => setAdvancedJson(e.currentTarget.value)}
            rows={10}
            spellCheck={false}
            aria-describedby="duress-advanced-hint"
          />
          <span id="duress-advanced-hint" className="duress-enroll__hint">
            Compiled by CONTRACT — settings does not invent security rules.
            enabled:true is preview only.
          </span>
        </label>
      )}
    </>
  );
}
