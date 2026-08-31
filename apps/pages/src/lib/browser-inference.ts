/**
 * What this device can run a model on, without one being configured.
 *
 * The models step is skippable, and skipping it used to mean the whole
 * password-reset ceremony was off: OpenSesame would open the right settings
 * page and hand the job back. That is a defensible floor, but it is not the
 * best one available, because the device rendering this PWA may already have a
 * model on it. A browser that carries its own on-device model can drive the
 * ceremony with a plane that is strictly *narrower* than every configured
 * option: no endpoint, no API key, no request, and — unlike even a loopback
 * Ollama — no second process holding the frames.
 *
 * So "bypass the providers" resolves to the browser plane where the browser
 * can actually carry it, and to nothing where it cannot. This module answers
 * only the second half of that: what is here. Nothing in it fetches, prompts,
 * downloads, or measures anything — a capability probe that costs a model
 * download is not a probe.
 *
 * ## The three planes, and why they are graded rather than one flag
 *
 *  1. **The browser's own model.** `LanguageModel.availability()` — the Prompt
 *     API. Weights belong to the browser, are shared across origins, and are
 *     never ours to ship. This is the plane we want.
 *  2. **WebGPU with weights we would have to fetch.** A small vision model can
 *     run in-page over WebGPU, but somebody has to send the weights, and this
 *     app is an offline Pages deploy whose whole posture is that it does not
 *     phone home. A weights fetch is egress to a model host, so it is an offer
 *     with a stated cost rather than a silent fallback.
 *  3. **Neither.** Which is a real answer and is reported as one.
 *
 * ## Why image input is queried separately, and why it is the deciding fact
 *
 * The ceremony needs a model that can *see the page* — ADR 0076 §1 gives it a
 * redacted picture and a `fill_credential(ref, selector)` tool, and a model
 * that cannot see has nothing to point at. The Prompt API gates image input
 * apart from text: the same device can answer `available` for text and
 * `unavailable` for images, on hardware or on build. Asking once and assuming
 * the answer covers both would enable the ceremony on devices that can only
 * ever fail it, which is the failure mode the setup screen exists to avoid.
 *
 * So availability is asked twice, and it is the *image* answer that decides
 * whether the browser plane is offered. A text-only built-in model reports as
 * its own outcome rather than as absence, because "your browser has a model
 * but it cannot see a page" and "your browser has no model" send an operator
 * to different places.
 */

import {
  type BoundaryValue,
  isFunction,
  isString,
} from "@opensesame/os-domain";

/**
 * The Prompt API's availability ladder, as the spec spells it.
 *
 * `downloadable` and `downloading` both mean the browser is willing — the
 * difference is whether someone has already started it — so both are treated
 * as present-but-not-yet-resident rather than as absent.
 */
export type ModelAvailability =
  | "unavailable"
  | "downloadable"
  | "downloading"
  | "available";

const AVAILABILITY = [
  "unavailable",
  "downloadable",
  "downloading",
  "available",
] as const satisfies readonly ModelAvailability[];

function isAvailability(value: string): value is ModelAvailability {
  return AVAILABILITY.some((rung) => rung === value);
}

/**
 * Read the browser's answer as a rung, or as absence.
 *
 * A browser that answers something this ladder does not know — an older
 * spelling, a vendor value, a future rung — is treated as unavailable rather
 * than optimistically as present. Guessing upward here would offer a ceremony
 * on a browser that cannot run it.
 */
function asAvailability(value: BoundaryValue): ModelAvailability {
  return isString(value) && isAvailability(value) ? value : "unavailable";
}

/** What the browser can do, once asked. */
export type BrowserInferenceReport = {
  /** True in a secure context, which the Prompt API requires. */
  readonly secureContext: boolean;
  /** Whether a `LanguageModel` global is exposed at all. */
  readonly builtinPresent: boolean;
  /** The built-in model's availability for text. */
  readonly text: ModelAvailability;
  /**
   * The built-in model's availability *for image input* — asked with
   * `expectedInputs: [{ type: "image" }]`, because that is the only question
   * whose answer this ceremony depends on.
   */
  readonly vision: ModelAvailability;
  /** Whether a WebGPU adapter exists, which is what an in-page model needs. */
  readonly webgpu: boolean;
};

/**
 * Which plane the browser can carry, ranked best-first.
 *
 * - `builtin` — the browser's own model, resident and able to see a page.
 *   Nothing is downloaded by us and nothing leaves the device.
 * - `builtin-download` — the same model, which the browser will fetch on first
 *   use. Still the browser's download, not ours, but it is not instant and an
 *   operator should not discover that mid-ceremony.
 * - `webgpu-download` — no built-in vision model, but the hardware could run a
 *   small one we would have to fetch. Offered, never assumed: fetching weights
 *   is egress, and this app's posture is that it does not make any.
 * - `none` — the device cannot run a model. The ceremony stays off and
 *   OpenSesame takes the operator to the settings page, as it does today.
 */
export type BrowserInferencePlane =
  | "builtin"
  | "builtin-download"
  | "webgpu-download"
  | "none";

/**
 * Why the browser plane is not the resident built-in model.
 *
 * Carried so the panel can say what is wrong rather than greying a control:
 * "this browser has no on-device model" and "it has one but it cannot see a
 * page" are different sentences and lead to different next steps.
 */
export type BrowserInferenceLimit =
  | "insecure-context"
  | "no-builtin"
  | "text-only"
  | "needs-download"
  | "no-hardware";

export type BrowserInferenceVerdict = {
  readonly plane: BrowserInferencePlane;
  readonly limit: BrowserInferenceLimit | null;
  readonly report: BrowserInferenceReport;
};

/**
 * The narrow slice of the Prompt API this module touches.
 *
 * Declared locally rather than pulled from a DOM lib: the API is not Baseline,
 * so a global type for it would assert across the codebase that every browser
 * has one. Every call site here is already guarded.
 */
type ExpectedInput = { readonly type: string };

/**
 * The one modality this ceremony turns on, named once.
 *
 * It is both the argument to `availability()` and the argument to `create()`
 * later, and the two must agree — asking about text and then creating a
 * multimodal session is how a probe comes back green on a device that then
 * refuses the session.
 */
const IMAGE_INPUT = [
  { type: "image" },
] as const satisfies readonly ExpectedInput[];

type LanguageModelLike = {
  availability?: (options?: {
    expectedInputs?: readonly ExpectedInput[];
  }) => Promise<BoundaryValue>;
};

type GpuLike = { requestAdapter?: () => Promise<BoundaryValue> };

/**
 * The globals, behind a seam.
 *
 * Tests supply them; nothing else does. Reading them through functions rather
 * than at module load matters because a browser can expose `LanguageModel`
 * after first paint, and a capability cached at import time would be a stale
 * "no" for the rest of the session.
 */
type InferenceGlobals = {
  LanguageModel?: LanguageModelLike;
  navigator?: { gpu?: GpuLike };
  isSecureContext?: boolean;
};

/**
 * `globalThis` as the three optional properties this module looks for.
 *
 * Every one is declared optional and every read below is guarded, so the shape
 * claims nothing about the running browser — it only says which names are
 * looked up. A DOM lib would instead assert the Prompt API exists everywhere,
 * which is the claim we are here to avoid making.
 */
const globals =
  /* SAFETY: InferenceGlobals declares every name optional, so the assertion
     asserts no runtime witness; the contract is checked at each read by the
     isFunction guards below before anything is called. */
  globalThis as InferenceGlobals;

export const browserInferenceSeams = {
  languageModel: (): LanguageModelLike | null => {
    const model = globals.LanguageModel;
    return model?.availability !== undefined && isFunction(model.availability)
      ? model
      : null;
  },
  gpu: (): GpuLike | null => {
    const gpu = globals.navigator?.gpu;
    return gpu?.requestAdapter !== undefined && isFunction(gpu.requestAdapter)
      ? gpu
      : null;
  },
  // Undefined means an environment with no notion of one — Node, jsdom, an SSR
  // pass — where reporting "insecure" would fail every test and every build.
  // Only an explicit `false` is a browser saying no.
  isSecureContext: (): boolean => globals.isSecureContext !== false,
};

async function availabilityFor(
  model: LanguageModelLike,
  expectedInputs?: readonly ExpectedInput[],
): Promise<ModelAvailability> {
  try {
    const answer = await model.availability?.(
      expectedInputs ? { expectedInputs } : undefined,
    );
    return asAvailability(answer);
  } catch {
    // A browser that throws on the probe is a browser that cannot serve the
    // request either. Treated as absence rather than surfaced, because there
    // is nothing an operator could do with the exception text.
    return "unavailable";
  }
}

async function hasWebGpuAdapter(): Promise<boolean> {
  const gpu = browserInferenceSeams.gpu();
  if (!gpu) return false;
  try {
    return (await gpu.requestAdapter?.()) != null;
  } catch {
    return false;
  }
}

/** Ask the browser what it has. Cheap: no weights, no prompts, no network. */
export async function probeBrowserInference(): Promise<BrowserInferenceReport> {
  const secureContext = browserInferenceSeams.isSecureContext();
  const model = secureContext ? browserInferenceSeams.languageModel() : null;
  const absent = async (): Promise<ModelAvailability> => "unavailable";
  const [text, vision, webgpu] = await Promise.all([
    model ? availabilityFor(model) : absent(),
    model ? availabilityFor(model, IMAGE_INPUT) : absent(),
    secureContext ? hasWebGpuAdapter() : Promise.resolve(false),
  ]);
  return {
    secureContext,
    builtinPresent: model !== null,
    text,
    vision,
    webgpu,
  };
}

/**
 * Turn a report into the one decision the rest of the app needs.
 *
 * Pure, so the ladder can be tested without a browser and so the panel and the
 * ceremony cannot drift into two different readings of the same report.
 */
export function readBrowserInference(
  report: BrowserInferenceReport,
): BrowserInferenceVerdict {
  const verdict = (
    plane: BrowserInferencePlane,
    limit: BrowserInferenceLimit | null,
  ): BrowserInferenceVerdict => ({ plane, limit, report });

  if (!report.secureContext) return verdict("none", "insecure-context");
  if (report.vision === "available") return verdict("builtin", null);
  if (report.vision === "downloadable" || report.vision === "downloading") {
    return verdict("builtin-download", "needs-download");
  }
  // Past here the built-in model cannot see a page, so it cannot carry this
  // ceremony however good it is at text. Say which of the two it is.
  const builtinLimit: BrowserInferenceLimit = report.builtinPresent
    ? report.text === "unavailable"
      ? "no-builtin"
      : "text-only"
    : "no-builtin";
  if (report.webgpu) return verdict("webgpu-download", builtinLimit);
  return verdict("none", report.builtinPresent ? builtinLimit : "no-hardware");
}

/** Probe and read in one step — what a screen actually calls. */
export async function browserInference(): Promise<BrowserInferenceVerdict> {
  return readBrowserInference(await probeBrowserInference());
}

/**
 * Whether a plane can drive the ceremony with nothing further asked of anyone.
 *
 * Only the resident built-in model qualifies. The two download planes are
 * capable but not yet ready, and a fallback that silently starts a download is
 * a fallback that turns "I skipped this step" into gigabytes on a phone.
 */
export function planeIsReady(plane: BrowserInferencePlane): boolean {
  return plane === "builtin";
}
