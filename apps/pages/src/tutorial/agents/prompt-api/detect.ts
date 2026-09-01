/**
 * Feature detection for the browser's built-in Prompt API (`LanguageModel`).
 *
 * The API ships only in recent desktop Chrome-family browsers, so nothing here
 * assumes a method exists, and no raw platform value leaves this module: a
 * caller only ever sees `LocalLanguageModelApi`, whose members are pre-bound to
 * the platform object and whose vocabulary is OpenSesame's, not the browser's.
 */

import {
  type BoundaryObject,
  type BoundaryValue,
  isFunction,
  isNumber,
  isString,
  isTypeofObject,
  overlapCast,
} from "@opensesame/os-domain";

export type LocalModelAvailabilityState =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

export type LocalModelPromptRole = "system" | "user" | "assistant";

export type LocalModelPrompt = {
  readonly role: LocalModelPromptRole;
  readonly content: string;
};

/** Receives the download fraction in `[0, 1]`. */
export type LocalModelProgressListener = (progress: number) => void;

export type LocalModelPromptOptions = {
  readonly signal: AbortSignal;
};

export type LocalModelSession = {
  prompt: (input: string, options: LocalModelPromptOptions) => Promise<string>;
  destroy: () => void;
};

export type LocalModelCreateOptions = {
  readonly initialPrompts: readonly LocalModelPrompt[];
  readonly monitor: LocalModelProgressListener | null;
  readonly signal: AbortSignal | null;
};

export type LocalLanguageModelApi = {
  availability: () => Promise<LocalModelAvailabilityState>;
  create: (options: LocalModelCreateOptions) => Promise<LocalModelSession>;
};

type PlatformProgressEvent = { readonly loaded: BoundaryValue };

type PlatformMonitor = {
  addEventListener: (
    type: string,
    listener: (event: PlatformProgressEvent) => void,
  ) => void;
};

type PlatformExpectation = {
  readonly type: "text";
  readonly languages: readonly string[];
};

type PlatformCreateOptions = {
  initialPrompts?: readonly LocalModelPrompt[];
  expectedInputs?: readonly PlatformExpectation[];
  expectedOutputs?: readonly PlatformExpectation[];
  monitor?: (monitor: PlatformMonitor) => void;
  signal?: AbortSignal;
};

/**
 * The language a session is created for. Chrome warns on every request that
 * omits it ("No output language was specified") and says quality suffers;
 * the support surface is authored in English, so that is what is declared.
 */
export const LOCAL_MODEL_LANGUAGES: readonly string[] = ["en"];

type PlatformAvailability = () => Promise<BoundaryValue>;
type PlatformCreate = (
  options: PlatformCreateOptions,
) => Promise<BoundaryValue>;
type PlatformPrompt = (
  input: string,
  options: LocalModelPromptOptions,
) => Promise<BoundaryValue>;
type PlatformDestroy = () => void;

const unusableSessionMessage =
  "The built-in language model returned a session without a usable prompt().";
const nonTextAnswerMessage =
  "The built-in language model answered with something that is not text.";

function normalizeAvailability(
  value: BoundaryValue,
): LocalModelAvailabilityState {
  if (!isString(value)) return "unavailable";
  switch (value) {
    // Chrome shipped `readily`/`after-download` before the spec renamed the
    // states; a browser mid-rename must not read as an absent model.
    case "available":
    case "readily":
      return "available";
    case "downloading":
      return "downloading";
    case "downloadable":
    case "after-download":
      return "downloadable";
    default:
      return "unavailable";
  }
}

/** `downloadprogress` reports a fraction; a browser that reports otherwise reports nothing. */
function progressFraction(value: BoundaryValue): number {
  if (!isNumber(value) || Number.isNaN(value)) return 0;
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}

function normalizeSession(value: BoundaryValue): LocalModelSession | null {
  if (
    value === null ||
    value === undefined ||
    !isTypeofObject(value) ||
    Array.isArray(value)
  ) {
    return null;
  }
  // SAFETY: checked above that the created session is a non-null, non-array
  // object, so reading its members through the boundary record is structural.
  const platformSession: BoundaryObject = overlapCast(value);
  const promptValue = platformSession.prompt;
  const destroyValue = platformSession.destroy;
  if (!isFunction(promptValue) || !isFunction(destroyValue)) return null;
  // SAFETY: isFunction established both members are callable; the call
  // signatures are the Prompt API contract this module owns.
  const prompt: PlatformPrompt = overlapCast(promptValue);
  const destroy: PlatformDestroy = overlapCast(destroyValue);
  return {
    prompt: async (input, options) => {
      const answer = await prompt.call(platformSession, input, {
        signal: options.signal,
      });
      if (!isString(answer)) throw new Error(nonTextAnswerMessage);
      return answer;
    },
    destroy: () => {
      destroy.call(platformSession);
    },
  };
}

export function detectLocalLanguageModel(): LocalLanguageModelApi | null {
  // SAFETY: the global object is a runtime record; reading a possibly-absent
  // member through the boundary type is what the check below validates.
  const globals: BoundaryObject = overlapCast(globalThis);
  const candidate = globals.LanguageModel;
  if (candidate === null || candidate === undefined) return null;
  // Chrome exposes `LanguageModel` as an interface object — a constructor —
  // so a function carries the static members just as legitimately as a record.
  const carriesMembers =
    isFunction(candidate) ||
    (isTypeofObject(candidate) && !Array.isArray(candidate));
  if (!carriesMembers) return null;
  // SAFETY: checked immediately above that the global is an object or a
  // function, both of which carry properties.
  const model: BoundaryObject = overlapCast(candidate);
  const availabilityValue = model.availability;
  const createValue = model.create;
  if (!isFunction(availabilityValue) || !isFunction(createValue)) return null;
  // SAFETY: isFunction established both members are callable; the signatures
  // are the Prompt API contract, and every returned value is re-validated.
  const availability: PlatformAvailability = overlapCast(availabilityValue);
  const create: PlatformCreate = overlapCast(createValue);
  return {
    availability: async () =>
      normalizeAvailability(await availability.call(model)),
    create: async (options) => {
      const payload: PlatformCreateOptions = {
        expectedInputs: [{ type: "text", languages: LOCAL_MODEL_LANGUAGES }],
        expectedOutputs: [{ type: "text", languages: LOCAL_MODEL_LANGUAGES }],
      };
      // An empty `initialPrompts` is not the same as none: send the member
      // only when there is a system instruction to seed the session with.
      if (options.initialPrompts.length > 0) {
        payload.initialPrompts = options.initialPrompts;
      }
      if (options.signal !== null) payload.signal = options.signal;
      const listener = options.monitor;
      if (listener !== null) {
        payload.monitor = (monitor) => {
          monitor.addEventListener("downloadprogress", (event) => {
            listener(progressFraction(event.loaded));
          });
        };
      }
      const created = await create.call(model, payload);
      const session = normalizeSession(created);
      if (session === null) throw new Error(unusableSessionMessage);
      return session;
    },
  };
}
