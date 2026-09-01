import { useCallback, useEffect, useState } from "react";
import {
  type BrowserInferenceLimit,
  type BrowserInferenceVerdict,
  browserInference,
} from "../../lib/browser-inference.js";
import {
  type ModelPlaneKind,
  type ModelProviderRecord,
  NO_MODEL_PROVIDER,
  type ResolvedModelPlane,
  loadModelProvider,
  resolveModelPlane,
  saveModelProvider,
} from "../../lib/model-provider.js";

type Flash = { tone: "ok" | "err"; text: string };

type Preset = {
  readonly id: string;
  readonly kind: ModelPlaneKind;
  readonly name: string;
  readonly kindLabel: string;
  readonly endpoint: string;
  readonly model: string;
};

/**
 * The sheet's list, as data. Local first, because the ordering is the argument:
 * the arrangements where nothing leaves the machine come before the ones where
 * something does.
 */
const PRESETS: readonly Preset[] = [
  {
    id: "ollama",
    kind: "local",
    name: "Ollama",
    kindLabel: "nothing leaves",
    endpoint: "http://127.0.0.1:11434",
    model: "qwen2.5-vl:7b",
  },
  {
    id: "lmstudio",
    kind: "local",
    name: "LM Studio",
    kindLabel: "nothing leaves",
    endpoint: "http://127.0.0.1:1234/v1",
    model: "qwen2.5-vl-7b",
  },
  {
    id: "anthropic",
    kind: "hosted",
    name: "Anthropic",
    kindLabel: "api key",
    endpoint: "https://api.anthropic.com",
    model: "claude-sonnet-5",
  },
  {
    id: "openai",
    kind: "hosted",
    name: "OpenAI",
    kindLabel: "api key",
    endpoint: "https://api.openai.com/v1",
    model: "",
  },
  {
    id: "openai-shaped",
    kind: "hosted",
    name: "Anything OpenAI-shaped",
    kindLabel: "bring a url",
    endpoint: "",
    model: "",
  },
];

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
 * Who runs the model that works a website's own password-reset form.
 *
 * The panel exists to make one thing legible that a settings form normally
 * hides: **not choosing is itself a choice, and it has an outcome**. Every
 * other panel here is inert until filled in. This one reports what is running
 * *right now* at the top — which, with nothing configured, may well be the
 * browser's own on-device model, an arrangement narrower than anything on the
 * list below it.
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
    setEndpoint(stored.endpoint);
    setModel(stored.model);
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
      setEndpoint(next.endpoint);
      setModel(next.model);
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
  // Offered only where the browser can carry it now. A rung that needs a
  // download is described below rather than presented as a one-tap option.
  const browserReady = verdict?.plane === "builtin";

  return (
    <section className="panel" id="model-provider">
      <div className="panel__head">
        <div>
          <h2>Who runs the model</h2>
        </div>
      </div>
      <div className="panel__body">
        {/* An `<output>`, because this line is a computed result rather than
            prose: it is what the record and the capability probe resolve to,
            and it changes under the reader as either one does. `.note` already
            lays it out as a flex row, so the element carries the semantics and
            nothing else moves. */}
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

        {browserReady ? (
          <div className="actions">
            <button
              type="button"
              className={record.kind === "browser" ? "btn btn--primary" : "btn"}
              disabled={busy || record.kind === "browser"}
              onClick={() =>
                void commit({
                  kind: "browser",
                  provider: "browser",
                  endpoint: "",
                  model: "",
                })
              }
            >
              {record.kind === "browser"
                ? "Using this device"
                : "Use this device's own model"}
            </button>
          </div>
        ) : verdict ? (
          <p className="note">
            <span>
              {LIMIT_TEXT[verdict.limit ?? "no-hardware"]}
              {verdict.plane === "webgpu-download"
                ? " This device could run a small one in the page instead, but somebody has to send the weights — which is a request to a model host, and this app makes none on its own."
                : ""}
            </span>
          </p>
        ) : null}

        <ul className="list">
          {PRESETS.map((preset) => (
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
                onClick={() =>
                  void commit({
                    kind: preset.kind,
                    provider: preset.id,
                    endpoint: preset.endpoint,
                    model: preset.model,
                  })
                }
              >
                {record.provider === preset.id ? "In use" : "Use"}
              </button>
            </li>
          ))}
        </ul>

        {record.kind === "local" || record.kind === "hosted" ? (
          <>
            <label className="field">
              <span>Endpoint</span>
              <input
                type="url"
                value={endpoint}
                onChange={(event) => setEndpoint(event.target.value)}
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
                placeholder="a vision model — it has to see the page"
                autoComplete="off"
                spellCheck={false}
              />
            </label>
            {/* No key field, here or anywhere: a provider's key is a secret and
                lives in the vault behind the same seal as everything else. */}
            <p className="note">
              <span>
                An API key is not asked for here. Keep it in the vault; this
                panel stores addresses only.
              </span>
            </p>
            <div className="actions">
              <button
                type="button"
                className="btn btn--primary"
                disabled={busy}
                onClick={() => void commit({ ...record, endpoint, model })}
              >
                {busy ? "Saving…" : "Save"}
              </button>
              <button
                type="button"
                className="btn"
                disabled={busy}
                onClick={() => void commit(NO_MODEL_PROVIDER)}
              >
                Use no provider
              </button>
            </div>
          </>
        ) : null}

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
