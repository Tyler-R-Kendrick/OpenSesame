/**
 * Step 2 — ai. Who runs the model that points during a guided change.
 * The same presets Settings › Model offers, in the ceremony's card
 * vocabulary: pick one and its endpoint and model can be refined right here
 * — nothing is left half-configured for a later screen. An API key is never
 * asked for; it belongs in the vault.
 */

import { useState } from "react";
import {
  type ModelProviderRecord,
  loadModelProvider,
  saveModelProvider,
} from "../../../lib/model-provider.js";
import {
  MODEL_PROVIDER_PRESETS,
  type ModelProviderPreset,
} from "../../../sections/settings/ModelProviderPanel.js";
import { StepHead } from "./shared.js";

function recordFor(preset: ModelProviderPreset): ModelProviderRecord {
  return {
    kind: preset.kind,
    provider: preset.id,
    endpoint: preset.endpoint,
    model: preset.model,
  };
}

export function AiStep() {
  const [record, setRecord] = useState<ModelProviderRecord>(loadModelProvider);
  const [endpoint, setEndpoint] = useState(record.endpoint);
  const [model, setModel] = useState(record.model);
  const [busy, setBusy] = useState(false);
  const commit = (next: ModelProviderRecord) => {
    setBusy(true);
    void saveModelProvider(next)
      .then(() => {
        setRecord(next);
        setEndpoint(next.endpoint);
        setModel(next.model);
      })
      .finally(() => setBusy(false));
  };
  const refine = record.kind === "local" || record.kind === "hosted";
  return (
    <>
      <StepHead title="Who runs the model?">
        A model points at the right control during a guided password change — it
        never acts on its own. Local presets keep every frame on this machine;
        hosted ones send redacted frames to the provider you name.
      </StepHead>

      <ul className="xcards" aria-label="Model providers">
        {MODEL_PROVIDER_PRESETS.map((preset) => {
          const inUse = record.provider === preset.id;
          return (
            <li key={preset.id} className={`xcard${inUse ? " is-on" : ""}`}>
              <button
                type="button"
                className="xcard__pick"
                aria-pressed={inUse}
                disabled={busy}
                onClick={() => commit(recordFor(preset))}
              >
                <span className="xcard__name">{preset.name}</span>
                <span className="xcard__kind">{preset.kindLabel}</span>
              </button>
              <span className="xcard__side">
                <span className={`chip${inUse ? " chip--ok" : ""}`}>
                  {inUse
                    ? "In use"
                    : preset.kind === "local"
                      ? "Local"
                      : "Hosted"}
                </span>
              </span>
            </li>
          );
        })}
      </ul>

      {refine ? (
        <>
          <label className="field">
            <span>Endpoint</span>
            <input
              type="url"
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              onBlur={() => commit({ ...record, endpoint, model })}
              placeholder="http://127.0.0.1:11434"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
          <label className="field">
            <span>Model</span>
            <input
              type="text"
              value={model}
              onChange={(event) => setModel(event.target.value)}
              onBlur={() => commit({ ...record, endpoint, model })}
              placeholder="a vision model — it has to see the page"
              autoComplete="off"
              spellCheck={false}
            />
          </label>
        </>
      ) : null}

      <p className="hint">
        An API key is not asked for here or anywhere — keep it in the vault.
      </p>
    </>
  );
}
