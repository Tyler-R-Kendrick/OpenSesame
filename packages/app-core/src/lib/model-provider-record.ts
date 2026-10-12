/** Shared model choices and encrypted settings; no provider or inference implementation. */
import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
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

/** Keys a stored choice is allowed to carry — used by tests. */
export function aiModelChoiceKeys(): readonly string[] {
  return CHOICE_KEYS;
}
