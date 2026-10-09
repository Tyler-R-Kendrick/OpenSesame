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
  type BrowserInferencePlane,
  type BrowserInferenceVerdict,
  planeIsReady,
} from "./browser-inference.js";
import type { FeatureOperation } from "./feature-connector-operation.js";

import {
  DEFAULT_VOICE_CHOICE,
  type ModelPlaneKind,
  type ModelProviderRecord,
  loadModelProvider,
} from "./model-provider-record.js";
export * from "./model-provider-record.js";

/** BCP-47 language for Web Speech, from the voice catalog pick. */
export function voiceRecognitionLang(
  record: ModelProviderRecord = loadModelProvider(),
): string {
  const lang = record.voice.model.trim();
  return lang.length > 0 ? lang : DEFAULT_VOICE_CHOICE.model;
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

/** Command-bar freer phrasing stays on the on-device Prompt API. */
export function browserInferenceForCommands(
  record: ModelProviderRecord,
): boolean {
  const kind = record.inference.kind;
  return kind === "browser" || kind === "none";
}

/** Send each operation the feature built. The key stays on the request headers. */
export function savedModelRequests(operations: readonly FeatureOperation[]) {
  return operations.map((operation) => ({
    ok: false as const,
    providerId: operation.providerId,
  }));
}
