import { useCallback, useEffect, useState } from "react";
import { IconCheck } from "../../components/Icons.js";
import { StatusMark } from "../../components/StatusMark.js";
import {
  type BrowserInferenceVerdict,
  browserInference,
} from "../../lib/browser-inference.js";
import { detectSpeechRecognition } from "../../lib/command-bar/speech.js";
import {
  MODEL_PROVIDER_PRESETS,
  type ModelProviderPreset,
} from "../../lib/model-catalog.js";
import {
  type ModelProviderRecord,
  NO_MODEL_PROVIDER,
  type ResolvedModelPlane,
  loadModelProvider,
  resolveModelPlane,
  saveModelProvider,
  withInference,
} from "../../lib/model-provider.js";
import {
  InferenceRefineFields,
  InferenceRolePicker,
  VoiceRolePicker,
  clearInference,
} from "./AiModelRoles.js";

export type { ModelProviderPreset };
export { MODEL_PROVIDER_PRESETS };

type Flash = { tone: "ok" | "err"; text: string };

function planeSentence(plane: ResolvedModelPlane): string {
  switch (plane.because) {
    case "configured":
      return plane.kind === "browser"
        ? "Running on this device, in this browser. Nothing leaves the page."
        : plane.kind === "local"
          ? "Running on this machine. Nothing crosses your network."
          : "Running at the provider you named. Redacted frames cross to them.";
    case "fell-back-to-browser":
      return "No provider set, so this device's own model is doing it. Nothing leaves the page — this is the narrowest arrangement available.";
    case "browser-not-ready":
      return "This device could run a model, but not without fetching one first. Until then password changes stay manual.";
    default:
      return "No model. OpenSesame opens the right settings page and you make the change yourself; it never half-tries.";
  }
}

/**
 * Who runs the model that works a website's own password-reset form, plus the
 * voice and inference catalog picks for the command bar.
 *
 * See `lib/model-provider.ts` for the bypass rule and
 * `lib/browser-inference.ts` for the capability ladder. Nothing here downloads
 * a model: an offer names its download, and pressing nothing starts none.
 */
export function ModelProviderPanel() {
  const [record, setRecord] = useState<ModelProviderRecord>(NO_MODEL_PROVIDER);
  const [verdict, setVerdict] = useState<BrowserInferenceVerdict | null>(null);
  const [endpoint, setEndpoint] = useState("");
  const [model, setModel] = useState("");
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);

  useEffect(() => {
    const stored = loadModelProvider();
    setRecord(stored);
    setEndpoint(stored.inference.endpoint);
    setModel(stored.inference.model);
    let live = true;
    void browserInference().then((result) => {
      if (live) setVerdict(result);
    });
    return () => {
      live = false;
    };
  }, []);

  const commit = useCallback(async (next: ModelProviderRecord) => {
    setBusy(true);
    setFlash(null);
    try {
      await saveModelProvider(next);
      setRecord(next);
      setEndpoint(next.inference.endpoint);
      setModel(next.inference.model);
      setFlash({ tone: "ok", text: "Saved." });
    } catch {
      setFlash({
        tone: "err",
        text: "Could not save this choice on this device.",
      });
    } finally {
      setBusy(false);
    }
  }, []);

  const plane = verdict ? resolveModelPlane(record, verdict) : null;
  const browserReady = verdict?.plane === "builtin";
  const speechReady = detectSpeechRecognition() !== null;

  return (
    <div className="conn-group" id="model-provider">
      <h3 className="conn-group__label">
        Models
        <StatusMark
          tone={plane ? (plane.kind === "none" ? "err" : "ok") : "idle"}
          label={plane ? planeSentence(plane) : "Checking"}
        />
      </h3>
      <div className="conn-tile">
        <div className="conn-tile__body">
          <VoiceRolePicker
            record={record}
            busy={busy}
            chrome="list"
            speechReady={speechReady}
            onCommit={(next) => void commit(next)}
          />

          {browserReady ? (
            <div className="actions">
              <button
                type="button"
                className="icon-btn"
                disabled={busy || record.inference.provider === "browser"}
                aria-label="Use this device's own model"
                title="Use this device's own model"
                onClick={() =>
                  void commit(
                    withInference(record, {
                      kind: "browser",
                      provider: "browser",
                      endpoint: "",
                      model: "",
                    }),
                  )
                }
              >
                <IconCheck size={16} />
              </button>
            </div>
          ) : null}

          <InferenceRolePicker
            record={record}
            busy={busy}
            chrome="list"
            browserReady={false}
            onCommit={(next) => void commit(next)}
          />

          <InferenceRefineFields
            record={record}
            busy={busy}
            endpoint={endpoint}
            model={model}
            setEndpoint={setEndpoint}
            setModel={setModel}
            mode="button"
            onCommit={(next) => void commit(next)}
            onClear={() => void commit(clearInference(record))}
          />

          {flash ? (
            <StatusMark
              tone={flash.tone === "ok" ? "ok" : "err"}
              label={flash.text}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}
