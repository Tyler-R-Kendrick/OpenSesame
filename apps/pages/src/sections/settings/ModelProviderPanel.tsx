import { useCallback, useEffect, useState } from "react";
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
} from "../../lib/model-provider.js";
import {
  type ModelSlugOption,
  connectedHarnessProviderIds,
  inferenceSlugOptions,
  voiceSlugOptions,
} from "../../lib/model-slugs.js";
import { ModelRoleSelects } from "./AiModelRoles.js";

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
 * Voice + inference role picks. Agent Harnesses configures hosted providers;
 * this panel only chooses which slug each role uses.
 */
export function ModelProviderPanel() {
  const [record, setRecord] = useState<ModelProviderRecord>(NO_MODEL_PROVIDER);
  const [verdict, setVerdict] = useState<BrowserInferenceVerdict | null>(null);
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState<Flash | null>(null);
  const [voiceOptions, setVoiceOptions] = useState<ModelSlugOption[]>(() =>
    voiceSlugOptions(detectSpeechRecognition() !== null),
  );
  const [inferenceOptions, setInferenceOptions] = useState<ModelSlugOption[]>(
    () =>
      inferenceSlugOptions({
        browserReady: false,
        connectedProviderIds: [],
      }),
  );

  useEffect(() => {
    const stored = loadModelProvider();
    setRecord(stored);
    const speechReady = detectSpeechRecognition() !== null;
    setVoiceOptions(voiceSlugOptions(speechReady));
    let live = true;
    void (async () => {
      const [browser, connected] = await Promise.all([
        browserInference(),
        connectedHarnessProviderIds(),
      ]);
      if (!live) return;
      setVerdict(browser);
      setInferenceOptions(
        inferenceSlugOptions({
          browserReady: browser.plane === "builtin",
          connectedProviderIds: connected,
        }),
      );
    })();
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
          <ModelRoleSelects
            record={record}
            busy={busy}
            voiceOptions={voiceOptions}
            inferenceOptions={inferenceOptions}
            onCommit={(next) => void commit(next)}
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
