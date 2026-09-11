/**
 * Step 2 — ai. Who runs the model that points during a guided change.
 * The same presets Settings › Model offers, persisted the same way; an API
 * key is never asked for — it belongs in the vault.
 */

import { useState } from "react";
import {
  type ModelProviderRecord,
  loadModelProvider,
  saveModelProvider,
} from "../../../lib/model-provider.js";
import { MODEL_PROVIDER_PRESETS } from "../../../sections/settings/ModelProviderPanel.js";
import { StepHead } from "./shared.js";

export function AiStep() {
  const [record, setRecord] = useState<ModelProviderRecord>(loadModelProvider);
  const [busy, setBusy] = useState(false);
  const choose = (presetId: string) => {
    const preset = MODEL_PROVIDER_PRESETS.find(
      (entry) => entry.id === presetId,
    );
    if (!preset) return;
    const next: ModelProviderRecord = {
      kind: preset.kind,
      provider: preset.id,
      endpoint: preset.endpoint,
      model: preset.model,
    };
    setBusy(true);
    void saveModelProvider(next)
      .then(() => setRecord(next))
      .finally(() => setBusy(false));
  };
  return (
    <>
      <StepHead title="Who runs the model?">
        A model points at the right control during a guided password change — it
        never acts on its own. Local presets keep every frame on this machine;
        hosted ones send redacted frames to the provider you name.
      </StepHead>

      <ul className="list">
        {MODEL_PROVIDER_PRESETS.map((preset) => (
          <li key={preset.id}>
            <div>
              <strong>{preset.name}</strong>
              <div className="muted">{preset.kindLabel}</div>
            </div>
            <button
              type="button"
              className={
                record.provider === preset.id ? "btn btn--primary" : "btn"
              }
              disabled={busy}
              onClick={() => choose(preset.id)}
            >
              {record.provider === preset.id ? "In use" : "Use"}
            </button>
          </li>
        ))}
      </ul>

      <p className="hint">
        Endpoints and model names can be refined from Settings › Model. An API
        key is not asked for here or anywhere — keep it in the vault.
      </p>
    </>
  );
}
