/**
 * `SupportAgentPort` over the browser's built-in on-device model.
 *
 * Nothing leaves the device: there is no SDK, no API key and no network call in
 * this file. The model sees exactly the system instruction the shared policy
 * builder produced from the authored page context, plus the sanitized question
 * and transcript — and it answers with text that the shared parser turns into a
 * `SupportTurn`. It is handed no affordance to call anything back.
 */

import type {
  SupportAgentAvailability,
  SupportAgentPort,
  SupportRequest,
  SupportRunOptions,
  SupportTurn,
} from "@opensesame/support-agent";
import {
  SUPPORT_LIMITS,
  SupportError,
  buildSupportInstructions,
  parseSupportTurn,
  sanitizeSupportRequest,
} from "@opensesame/support-agent";
import {
  type LocalLanguageModelApi,
  type LocalModelAvailabilityState,
  type LocalModelProgressListener,
  type LocalModelSession,
  detectLocalLanguageModel,
} from "./detect.js";

export type PromptApiAgentOptions = {
  /**
   * The detected platform surface. Omit it to detect at call time; pass `null`
   * to state that the platform is absent (which is how the tests drive it).
   */
  readonly api?: LocalLanguageModelApi | null;
  readonly onDownloadProgress?: LocalModelProgressListener | null;
};

/**
 * The on-device model is one browser-wide resource: the download a person
 * started from a settings click is the same one the support panel is waiting
 * on, so the last observed fraction is tracked per document, not per agent.
 */
const downloadProgress = { latest: 0 };

export function readLocalModelDownloadProgress(): number {
  return downloadProgress.latest;
}

export function resetLocalModelDownloadProgressForTest(): void {
  downloadProgress.latest = 0;
}

const emptyAnswerText =
  "The on-device model returned nothing this time. Ask again, or rephrase.";

const contextExhaustionNames = new Set([
  "QuotaExceededError",
  "ContextWindowExceededError",
]);

const contextExhaustionText =
  /quota|context (?:window|length)|token limit|too many tokens|session is full/iu;

function resolveApi(
  options: PromptApiAgentOptions,
): LocalLanguageModelApi | null {
  return options.api === undefined ? detectLocalLanguageModel() : options.api;
}

function abortedError(): SupportError {
  return new SupportError(
    "AGENT_ABORTED",
    "The support request was cancelled.",
  );
}

function isAbort(cause: unknown): boolean {
  if (cause instanceof SupportError) return cause.code === "AGENT_ABORTED";
  return cause instanceof Error && cause.name === "AbortError";
}

/**
 * A full session is the one failure worth a second attempt: the transcript, not
 * the question, is what ran out of room.
 */
function isContextExhausted(cause: unknown): boolean {
  if (!(cause instanceof Error)) return false;
  return (
    contextExhaustionNames.has(cause.name) ||
    contextExhaustionText.test(cause.message)
  );
}

function protocolError(cause: unknown): SupportError {
  const detail =
    cause instanceof Error
      ? cause.message
      : "the model failed without a reason";
  return new SupportError(
    "AGENT_PROTOCOL_ERROR",
    `The on-device model could not answer: ${detail}`,
  );
}

function rethrowAbort(cause: unknown): void {
  if (isAbort(cause)) throw abortedError();
}

function toAvailability(
  state: LocalModelAvailabilityState,
): SupportAgentAvailability {
  switch (state) {
    case "available":
      return { kind: "ready" };
    case "downloading":
      return { kind: "downloading", progress: downloadProgress.latest };
    case "downloadable":
      return { kind: "downloadable" };
    default:
      return { kind: "unavailable", reason: "platform_unsupported" };
  }
}

function recordProgress(
  options: PromptApiAgentOptions,
): LocalModelProgressListener {
  const listener = options.onDownloadProgress ?? null;
  return (progress) => {
    downloadProgress.latest = progress;
    if (listener !== null) listener(progress);
  };
}

/** Renders the turn the model is asked to answer. Sanitized text only. */
function renderTurn(request: SupportRequest): string {
  const lines: string[] = [];
  for (const message of request.history.slice(
    -SUPPORT_LIMITS.maxHistoryTurns,
  )) {
    lines.push(
      `${message.role === "user" ? "Person" : "Assistant"}: ${message.text}`,
    );
  }
  lines.push(`Person: ${request.question}`);
  return lines.join("\n");
}

/**
 * A model that answers in prose the parser rejects has given a bad answer, not
 * broken the panel: keep the prose, and never keep a guide we could not parse.
 */
function toTurn(raw: string): SupportTurn {
  try {
    return parseSupportTurn(raw);
  } catch {
    const answer = raw.trim().slice(0, SUPPORT_LIMITS.maxAnswerChars);
    return {
      answer: answer.length > 0 ? answer : emptyAnswerText,
      guide: null,
      suggestedQuestions: [],
    };
  }
}

/**
 * Aborting cancels the in-flight request and nothing else. The session survives
 * — `destroy()` is what tears it down — and a platform answer that arrives
 * after the abort is dropped rather than returned to a caller that gave up.
 */
function promptOnce(
  session: LocalModelSession,
  text: string,
  signal: AbortSignal,
): Promise<string> {
  if (signal.aborted) return Promise.reject(abortedError());
  return new Promise<string>((resolve, reject) => {
    let settled = false;
    const onAbort = () => {
      if (settled) return;
      settled = true;
      reject(abortedError());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    const claim = (): boolean => {
      signal.removeEventListener("abort", onAbort);
      if (settled) return false;
      settled = true;
      return true;
    };
    session.prompt(text, { signal }).then(
      (answer) => {
        if (claim()) resolve(answer);
      },
      (cause) => {
        if (claim()) reject(cause);
      },
    );
  });
}

/**
 * Acquires the on-device model. Must be called from an explicit user action:
 * the first call can cost a multi-gigabyte download, which is why `run()`
 * refuses instead of starting one on a person's behalf.
 */
export async function acquireLocalModel(
  options: PromptApiAgentOptions = {},
): Promise<SupportAgentAvailability> {
  const api = resolveApi(options);
  if (api === null) return { kind: "unavailable", reason: "no_local_model" };
  const before = await api.availability();
  if (before === "unavailable") {
    return { kind: "unavailable", reason: "platform_unsupported" };
  }
  if (before === "available") return { kind: "ready" };
  try {
    const session = await api.create({
      initialPrompts: [],
      monitor: recordProgress(options),
      signal: null,
    });
    session.destroy();
  } catch {
    return { kind: "unavailable", reason: "model_not_downloaded" };
  }
  return toAvailability(await api.availability());
}

/**
 * The pair `tutorial/session.ts` binds to.
 *
 * `createPromptApiAgent` answers `null` when the browser has no built-in model
 * at all, which is what lets the session fall through to another transport
 * instead of holding an agent that could only ever refuse. A model that is
 * present but not yet downloaded still yields an agent: that case is a gesture
 * away from working, and the panel should say so.
 */
export function createPromptApiAgent(
  options: PromptApiAgentOptions = {},
): SupportAgentPort | null {
  const api = resolveApi(options);
  if (api === null) return null;
  return createPromptApiSupportAgent({ ...options, api });
}

/** Throws rather than returning a state, because the caller reports failures. */
export async function acquirePromptApiModel(
  onProgress: LocalModelProgressListener,
  options: PromptApiAgentOptions = {},
): Promise<void> {
  const acquired = await acquireLocalModel({
    ...options,
    onDownloadProgress: onProgress,
  });
  if (acquired.kind === "ready") return;
  const detail =
    acquired.kind === "unavailable" ? acquired.reason : acquired.kind;
  throw new SupportError(
    "AGENT_UNAVAILABLE",
    `The on-device model could not be acquired: ${detail}.`,
  );
}

type ActiveSession = {
  readonly session: LocalModelSession;
  readonly instructions: string;
};

export function createPromptApiSupportAgent(
  options: PromptApiAgentOptions = {},
): SupportAgentPort {
  let active: ActiveSession | null = null;

  function dropSession(): void {
    const current = active;
    active = null;
    if (current !== null) current.session.destroy();
  }

  /**
   * Reuses the session unless the instruction changed, because the instruction
   * is the page context: a stale session would answer about the previous page.
   */
  async function useSession(
    api: LocalLanguageModelApi,
    instructions: string,
    signal: AbortSignal,
  ): Promise<LocalModelSession> {
    const current = active;
    if (current !== null && current.instructions === instructions) {
      return current.session;
    }
    dropSession();
    const session = await api.create({
      initialPrompts: [{ role: "system", content: instructions }],
      monitor: recordProgress(options),
      signal: null,
    });
    active = { session, instructions };
    if (signal.aborted) throw abortedError();
    return session;
  }

  async function ask(
    api: LocalLanguageModelApi,
    instructions: string,
    text: string,
    signal: AbortSignal,
  ): Promise<SupportTurn> {
    const session = await useSession(api, instructions, signal);
    return toTurn(await promptOnce(session, text, signal));
  }

  return {
    async availability(): Promise<SupportAgentAvailability> {
      const api = resolveApi(options);
      if (api === null)
        return { kind: "unavailable", reason: "no_local_model" };
      return toAvailability(await api.availability());
    },

    async run(
      request: SupportRequest,
      runOptions: SupportRunOptions,
    ): Promise<SupportTurn> {
      const api = resolveApi(options);
      if (api === null) {
        throw new SupportError(
          "AGENT_UNAVAILABLE",
          "This browser has no built-in language model.",
        );
      }
      if (runOptions.signal.aborted) throw abortedError();
      const state = await api.availability();
      if (state !== "available") {
        throw new SupportError(
          "AGENT_UNAVAILABLE",
          `The on-device model is ${state}. Acquiring it downloads gigabytes, so it only starts when a person asks for it.`,
        );
      }
      const sanitized = sanitizeSupportRequest(request);
      const instructions = buildSupportInstructions(sanitized.context);
      const text = renderTurn(sanitized);
      try {
        return await ask(api, instructions, text, runOptions.signal);
      } catch (cause) {
        rethrowAbort(cause);
        if (!isContextExhausted(cause)) throw protocolError(cause);
        dropSession();
        try {
          return await ask(api, instructions, text, runOptions.signal);
        } catch (retryCause) {
          rethrowAbort(retryCause);
          throw protocolError(retryCause);
        }
      }
    },

    destroy(): void {
      dropSession();
    },
  };
}
