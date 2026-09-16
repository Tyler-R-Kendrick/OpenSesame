import { useCallback, useEffect, useState } from "react";
import {
  type BrowserInferenceLimit,
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

/**
 * What the device is short of, said plainly.
 *
 * A greyed control asserts the action exists and merely is not available right
 * now, which is a different and untrue claim on a laptop that will never have
 * an on-device model. So the reason is spelled out and the option is withheld
 * rather than disabled.
 */
const LIMIT_TEXT = {
  "insecure-context":
    "This page is not in a secure context, so the browser withholds its model. Serve it over HTTPS or loopback.",
  "no-builtin": "This browser carries no on-device model.",
  "text-only":
    "This browser's on-device model reads text but cannot be shown a page, and a model that cannot see has nothing to point at.",
  "needs-download":
    "This browser has the model but has not fetched it yet. It is the browser's own download, once, and shared with every site that asks.",
  "no-hardware":
    "This device has neither an on-device model nor the graphics support to run one.",
} as const satisfies Record<BrowserInferenceLimit, string>;

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
    <section className="panel" id="model-provider">
      <div className="panel__head">
        <div>
          <h2>AI models</h2>
        </div>
      </div>
      <div className="panel__body">
        {plane ? (
          <output
            className={`note note--${plane.kind === "none" ? "err" : "ok"}`}
          >
            <span>{planeSentence(plane)}</span>
          </output>
        ) : (
          <output className="note">
            <span>Checking what this device can run…</span>
          </output>
        )}

        <VoiceRolePicker
          record={record}
          busy={busy}
          chrome="list"
          speechReady={speechReady}
          onCommit={(next) => void commit(next)}
        />

        {!browserReady && verdict ? (
          <p className="note">
            <span>
              {LIMIT_TEXT[verdict.limit ?? "no-hardware"]}
              {verdict.plane === "webgpu-download"
                ? " This device could run a small one in the page instead, but somebody has to send the weights — which is a request to a model host, and this app makes none on its own."
                : ""}
            </span>
          </p>
        ) : null}

        {browserReady ? (
          <div className="actions">
            <button
              type="button"
              className={
                record.inference.provider === "browser"
                  ? "btn btn--primary"
                  : "btn"
              }
              disabled={busy || record.inference.provider === "browser"}
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
              {record.inference.provider === "browser"
                ? "Using this device"
                : "Use this device's own model"}
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
          <p
            className={`note note--${flash.tone}`}
            role={flash.tone === "err" ? "alert" : "status"}
          >
            <span>{flash.text}</span>
          </p>
        ) : null}
      </div>
    </section>
  );
}
