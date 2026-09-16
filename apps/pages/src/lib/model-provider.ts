/**
 * Who runs the model that works a website's own password-reset form, plus the
 * AI roles used by the command bar (voice STT + inference LLM).
 *
 * The setup board offers this and does not require it (`docs/design/
 * setup-next-steps/`). What this module holds is the answer, and the rule for
 * what happens when the answer is "none of these" — which is the interesting
 * half, because bypassing the providers is not the same as declining the
 * feature.
 *
 * ## The bypass rule
 *
 * Skipping the step used to mean the ceremony was off. It still can, but only
 * where it has to be: the device rendering this PWA may already carry a model,
 * and a browser's own on-device model is a *narrower* plane than every option
 * on the sheet — no endpoint, no key, no request, and, unlike even a loopback
 * Ollama, no second process holding the frames. Declining to name a provider
 * therefore resolves to the browser plane where the browser can carry it, and
 * to nothing where it cannot.
 *
 * Nothing here downloads a model to make that true. A resident built-in model
 * is used; a downloadable one is offered with the download named; weights we
 * would have to fetch ourselves are an offer with egress stated, never a
 * silent consequence of pressing skip on an offline-first app. See
 * `lib/browser-inference.ts` for that ladder.
 *
 * ## Voice vs inference
 *
 * The same record also stores two catalog picks: `voice` (speech recognition
 * language / engine) and `inference` (LLM for freer command phrasing and the
 * password-reset plane). Top-level `kind` / `provider` / `endpoint` / `model`
 * stay synced to `inference` so older readers keep working.
 *
 * ## What is not stored here
 *
 * No API key, ever. A hosted provider's key is a secret and belongs in the
 * vault behind the same seal as everything else; this record names the
 * arrangement — kind, endpoint, model id — and nothing that could be used to
 * make a request on its own. `endpoint` and `model` are addresses, not
 * credentials, and the type has no field a key could be smuggled into.
 */

import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import {
  type BrowserInferencePlane,
  type BrowserInferenceVerdict,
  planeIsReady,
} from "./browser-inference.js";
import { kvGet, kvSetDurable } from "./kv.js";

export const MODEL_PROVIDER_KEY = "model-provider.v1";

/**
 * Where the model runs.
 *
 * - `local` — a model server on this machine, reached over loopback (Ollama,
 *   LM Studio). Nothing crosses the network.
 * - `hosted` — somebody else's API. The redacted frames cross to them; the
 *   boundary sheet is about exactly this case.
 * - `browser` — the device rendering this app, in-page. Nothing leaves the
 *   browser process.
 * - `none` — no model. The ceremony is off and OpenSesame opens the right
 *   settings page instead, which is what it does today.
 */
export type ModelPlaneKind = "local" | "hosted" | "browser" | "none";

/** One catalog pick — voice STT or inference LLM. */
export type AiModelChoice = {
  readonly provider: string;
  readonly kind: ModelPlaneKind;
  readonly endpoint: string;
  readonly model: string;
};

export type ModelProviderRecord = {
  readonly kind: ModelPlaneKind;
  /**
   * The preset the operator picked — `"ollama"`, `"anthropic"`, `"browser"`,
   * and so on. Free-form because the sheet's list is data, not a closed set.
   * Synced from `inference.provider`.
   */
  readonly provider: string;
  /** Where to reach it. Empty for `browser` and `none`, which have no address. */
  readonly endpoint: string;
  /** Which model, where that is the caller's choice. Empty where it is not. */
  readonly model: string;
  /** Speech recognition pick from the voice catalog. */
  readonly voice: AiModelChoice;
  /** LLM pick from the inference catalog (also drives password-reset). */
  readonly inference: AiModelChoice;
};

export const DEFAULT_VOICE_CHOICE: AiModelChoice = {
  provider: "browser-speech",
  kind: "browser",
  endpoint: "",
  model: "en-US",
};

export const NO_INFERENCE_CHOICE: AiModelChoice = {
  provider: "",
  kind: "none",
  endpoint: "",
  model: "",
};

export const NO_MODEL_PROVIDER: ModelProviderRecord = {
  kind: "none",
  provider: "",
  endpoint: "",
  model: "",
  voice: DEFAULT_VOICE_CHOICE,
  inference: NO_INFERENCE_CHOICE,
};

const KINDS = [
  "local",
  "hosted",
  "browser",
  "none",
] as const satisfies readonly ModelPlaneKind[];

const CHOICE_KEYS = ["provider", "kind", "endpoint", "model"] as const;

function isPlaneKind(value: string): value is ModelPlaneKind {
  return KINDS.some((kind) => kind === value);
}

/**
 * Read a stored kind, or fall to `none`.
 *
 * An unrecognised kind is no provider rather than a best guess: the only thing
 * a wrong guess could buy is aiming frames somewhere the operator did not
 * choose, and turning the ceremony off costs a re-answer.
 */
function readKind(value: BoundaryValue | undefined): ModelPlaneKind {
  return isString(value) && isPlaneKind(value) ? value : "none";
}

function readText(value: BoundaryValue | undefined): string {
  return isString(value) ? value.trim() : "";
}

function normalizeChoice(choice: AiModelChoice): AiModelChoice {
  const kind = isPlaneKind(choice.kind) ? choice.kind : "none";
  if (kind === "none") return NO_INFERENCE_CHOICE;
  return {
    kind,
    provider: choice.provider.trim(),
    endpoint: kind === "browser" ? "" : choice.endpoint.trim(),
    model: choice.model.trim(),
  };
}

function choiceFromTop(
  kind: ModelPlaneKind,
  provider: string,
  endpoint: string,
  model: string,
): AiModelChoice {
  return normalizeChoice({ kind, provider, endpoint, model });
}

function readChoice(
  value: BoundaryValue | undefined,
  fallback: AiModelChoice,
): AiModelChoice {
  if (!isJsonObject(value)) return fallback;
  return normalizeChoice({
    kind: readKind(value.kind),
    provider: readText(value.provider),
    endpoint: readText(value.endpoint),
    model: readText(value.model),
  });
}

function recordFromInference(
  inference: AiModelChoice,
  voice: AiModelChoice,
): ModelProviderRecord {
  const next = normalizeChoice(inference);
  if (next.kind === "none") {
    return {
      ...NO_MODEL_PROVIDER,
      voice:
        normalizeChoice(voice).kind === "none"
          ? DEFAULT_VOICE_CHOICE
          : normalizeChoice(voice),
      inference: NO_INFERENCE_CHOICE,
    };
  }
  const voiceNext = normalizeChoice(voice);
  return {
    kind: next.kind,
    provider: next.provider,
    endpoint: next.endpoint,
    model: next.model,
    voice: voiceNext.kind === "none" ? DEFAULT_VOICE_CHOICE : voiceNext,
    inference: next,
  };
}

function loadModelProviderDefault(): ModelProviderRecord {
  try {
    const raw = kvGet(MODEL_PROVIDER_KEY);
    if (!raw) return NO_MODEL_PROVIDER;
    const parsed: BoundaryValue = JSON.parse(raw);
    if (!isJsonObject(parsed)) return NO_MODEL_PROVIDER;
    const kind = readKind(parsed.kind);
    const provider = readText(parsed.provider);
    const endpoint = kind === "browser" ? "" : readText(parsed.endpoint);
    const model = readText(parsed.model);
    const topInference = choiceFromTop(kind, provider, endpoint, model);
    const hasRoles =
      parsed.voice !== undefined || parsed.inference !== undefined;
    if (kind === "none" && !hasRoles) return NO_MODEL_PROVIDER;
    const inference = readChoice(parsed.inference, topInference);
    const voice = readChoice(parsed.voice, DEFAULT_VOICE_CHOICE);
    return recordFromInference(inference, voice);
  } catch {
    // A corrupt record reads as no provider, which turns the ceremony off
    // rather than pointing it at a half-parsed address. Failing closed here
    // costs a re-answer; failing open would aim frames somewhere unintended.
    return NO_MODEL_PROVIDER;
  }
}

async function saveModelProviderDefault(
  record: ModelProviderRecord,
): Promise<void> {
  const next = recordFromInference(record.inference, record.voice);
  await kvSetDurable(MODEL_PROVIDER_KEY, JSON.stringify(next));
}

export const modelProviderSeams = {
  loadModelProvider: loadModelProviderDefault,
  saveModelProvider: saveModelProviderDefault,
};

export function loadModelProvider(): ModelProviderRecord {
  return modelProviderSeams.loadModelProvider();
}

export async function saveModelProvider(
  record: ModelProviderRecord,
): Promise<void> {
  return modelProviderSeams.saveModelProvider(record);
}

/** Build a full record from top-level fields (fills default voice / inference). */
export function modelProviderRecord(
  partial: Omit<ModelProviderRecord, "voice" | "inference"> &
    Partial<Pick<ModelProviderRecord, "voice" | "inference">>,
): ModelProviderRecord {
  const inference =
    partial.inference ??
    choiceFromTop(
      partial.kind,
      partial.provider,
      partial.endpoint,
      partial.model,
    );
  return recordFromInference(inference, partial.voice ?? DEFAULT_VOICE_CHOICE);
}

/** Replace the voice catalog pick; inference (and top-level) stay put. */
export function withVoice(
  record: ModelProviderRecord,
  voice: AiModelChoice,
): ModelProviderRecord {
  return recordFromInference(record.inference, voice);
}

/** Replace the inference catalog pick; syncs top-level fields. */
export function withInference(
  record: ModelProviderRecord,
  inference: AiModelChoice,
): ModelProviderRecord {
  return recordFromInference(inference, record.voice);
}

/** BCP-47 language for Web Speech, from the voice catalog pick. */
export function voiceRecognitionLang(
  record: ModelProviderRecord = loadModelProvider(),
): string {
  const lang = record.voice.model.trim();
  return lang.length > 0 ? lang : DEFAULT_VOICE_CHOICE.model;
}

/** Keys a stored choice is allowed to carry — used by tests. */
export function aiModelChoiceKeys(): readonly string[] {
  return CHOICE_KEYS;
}

/**
 * What will actually run, given the choice and what the device can do.
 *
 * Two facts, one answer, and the reason kept beside it so a screen never has
 * to re-derive why.
 */
export type ResolvedModelPlane = {
  readonly kind: ModelPlaneKind;
  /** The browser plane's rung, where `kind` is `browser`. `none` otherwise. */
  readonly browserPlane: BrowserInferencePlane;
  /**
   * Why this and not something better:
   *
   * - `configured` — the operator named a provider and it is being used.
   * - `fell-back-to-browser` — no provider named; the browser carries it.
   * - `no-plane` — no provider named and the device cannot carry one.
   * - `browser-not-ready` — the browser was chosen, or fell to, a rung that
   *   needs a download first. Capable, not yet running.
   */
  readonly because:
    | "configured"
    | "fell-back-to-browser"
    | "no-plane"
    | "browser-not-ready";
};

/**
 * The whole bypass rule, in one pure function.
 *
 * A configured provider always wins — an operator who named one is not
 * second-guessed by a capability probe, and a device that happens to carry a
 * model is not a reason to ignore the endpoint somebody typed.
 *
 * Only when nothing is named does the browser plane come into it, and then
 * only on the rung that is ready now. A device that *could* run a model after
 * a download is reported as capable-but-not-ready rather than resolved to,
 * because pressing skip must not start a multi-gigabyte fetch on a phone.
 */
export function resolveModelPlane(
  record: ModelProviderRecord,
  verdict: BrowserInferenceVerdict,
): ResolvedModelPlane {
  if (record.kind === "local" || record.kind === "hosted") {
    return { kind: record.kind, browserPlane: "none", because: "configured" };
  }
  if (record.kind === "browser") {
    return planeIsReady(verdict.plane)
      ? { kind: "browser", browserPlane: verdict.plane, because: "configured" }
      : {
          kind: "none",
          browserPlane: verdict.plane,
          because: "browser-not-ready",
        };
  }
  if (planeIsReady(verdict.plane)) {
    return {
      kind: "browser",
      browserPlane: verdict.plane,
      because: "fell-back-to-browser",
    };
  }
  return {
    kind: "none",
    browserPlane: verdict.plane,
    because: verdict.plane === "none" ? "no-plane" : "browser-not-ready",
  };
}

/**
 * Whether the autonomous ceremony is on.
 *
 * The single question the rotation path asks. Everything above exists so this
 * answer is one read rather than a rule re-implemented per caller.
 */
export function autonomousResetAvailable(plane: ResolvedModelPlane): boolean {
  return plane.kind !== "none";
}

/**
 * Whether command-bar freer phrasing may call the on-device Prompt API.
 *
 * Local/hosted inference is for support and password-reset; the omnibox stays
 * on the browser Prompt API when the operator picked browser (or left
 * inference unset so the bypass can fall to it).
 */
export function browserInferenceForCommands(
  record: ModelProviderRecord,
): boolean {
  const kind = record.inference.kind;
  return kind === "browser" || kind === "none";
}
