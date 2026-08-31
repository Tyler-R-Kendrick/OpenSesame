/**
 * The support conversation, held in memory for exactly as long as the panel is
 * open.
 *
 * The transcript below lives in this closure and nowhere else. It is never
 * written to `localStorage`, IndexedDB, a log line, an analytics event or a
 * telemetry span, and `destroy()` drops it along with the provider's own
 * session. A person asking for help types what is on their mind, and the least
 * we owe them is that it does not outlive the conversation.
 */

import type { GuideProgram } from "@opensesame/guide-lang";
import {
  type SupportAgentAvailability,
  type SupportAgentPort,
  SupportError,
  type SupportErrorCode,
  type SupportMessage,
  type SupportPageContext,
} from "./contract.js";
import { SupportEgressRefused } from "./egress.js";
import {
  type GuideCompileFailureSummary,
  type SupportGuideVocabulary,
  runSupportTurn,
} from "./turn.js";

export type SupportSessionStatus = "idle" | "asking" | "error" | "destroyed";

export type SupportSessionSnapshot = {
  readonly status: SupportSessionStatus;
  readonly messages: readonly SupportMessage[];
  readonly program: GuideProgram | null;
  readonly guideError: GuideCompileFailureSummary | null;
  readonly suggestedQuestions: readonly string[];
  readonly error: SupportErrorCode | null;
  /** Monotonic. A result carrying an older generation is discarded. */
  readonly generation: number;
};

export type SupportSessionDeps = {
  readonly port: SupportAgentPort;
  readonly vocabulary: SupportGuideVocabulary;
  /** Read fresh on every ask: the page the person is looking at moves. */
  readonly readContext: () => SupportPageContext;
};

export interface SupportSession {
  snapshot(): SupportSessionSnapshot;
  messages(): readonly SupportMessage[];
  subscribe(listener: (snapshot: SupportSessionSnapshot) => void): () => void;
  availability(): Promise<SupportAgentAvailability>;
  ask(question: string): Promise<void>;
  /** Abandon the request in flight. The transcript survives. */
  cancel(): void;
  /** Empty the transcript. The provider session survives. */
  clear(): void;
  /** Empty the transcript and drop the provider session. */
  destroy(): void;
}

function errorCodeOf(cause: unknown): SupportErrorCode {
  if (cause instanceof SupportEgressRefused) return "EGRESS_REFUSED";
  if (cause instanceof SupportError) return cause.code;
  if (cause instanceof Error && cause.name === "AbortError")
    return "AGENT_ABORTED";
  return "AGENT_PROTOCOL_ERROR";
}

export function createSupportSession(deps: SupportSessionDeps): SupportSession {
  let status: SupportSessionStatus = "idle";
  let transcript: SupportMessage[] = [];
  let program: GuideProgram | null = null;
  let guideError: GuideCompileFailureSummary | null = null;
  let suggestedQuestions: readonly string[] = [];
  let error: SupportErrorCode | null = null;
  /**
   * Every ask takes the next generation. A late result compares its own
   * generation against this one and drops itself if it lost the race, which is
   * what keeps a slow first answer from overwriting a fast second one.
   */
  let generation = 0;
  let inFlight: AbortController | null = null;
  const listeners = new Set<(snapshot: SupportSessionSnapshot) => void>();

  function snapshot(): SupportSessionSnapshot {
    return {
      status,
      messages: transcript.slice(),
      program,
      guideError,
      suggestedQuestions,
      error,
      generation,
    };
  }

  function publish(): void {
    const current = snapshot();
    for (const listener of listeners) listener(current);
  }

  function abortInFlight(): void {
    const controller = inFlight;
    inFlight = null;
    if (controller !== null) controller.abort();
  }

  async function ask(question: string): Promise<void> {
    if (status === "destroyed") {
      error = "AGENT_UNAVAILABLE";
      publish();
      return;
    }
    const trimmed = question.trim();
    if (trimmed.length === 0) return;

    abortInFlight();
    const controller = new AbortController();
    inFlight = controller;
    generation += 1;
    const mine = generation;

    transcript.push({ role: "user", text: trimmed });
    status = "asking";
    program = null;
    guideError = null;
    suggestedQuestions = [];
    error = null;
    publish();

    try {
      const availability = await deps.port.availability();
      if (mine !== generation) return;
      if (availability.kind !== "ready") {
        status = "error";
        error = "AGENT_UNAVAILABLE";
        publish();
        return;
      }
      const outcome = await runSupportTurn(
        deps.port,
        {
          question: trimmed,
          history: transcript.slice(0, -1),
          context: deps.readContext(),
        },
        deps.vocabulary,
        { signal: controller.signal },
      );
      if (mine !== generation) return;
      transcript.push({ role: "assistant", text: outcome.answer });
      program = outcome.program;
      guideError = outcome.guideError;
      suggestedQuestions = outcome.suggestedQuestions;
      status = "idle";
      publish();
    } catch (cause) {
      if (mine !== generation) return;
      status = "error";
      error = errorCodeOf(cause);
      publish();
    } finally {
      if (mine === generation) inFlight = null;
    }
  }

  return {
    snapshot,
    messages(): readonly SupportMessage[] {
      return transcript.slice();
    },
    subscribe(listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    availability(): Promise<SupportAgentAvailability> {
      return deps.port.availability();
    },
    ask,
    cancel(): void {
      abortInFlight();
      generation += 1;
      if (status === "asking") status = "idle";
      publish();
    },
    clear(): void {
      abortInFlight();
      generation += 1;
      transcript = [];
      program = null;
      guideError = null;
      suggestedQuestions = [];
      error = null;
      if (status !== "destroyed") status = "idle";
      publish();
    },
    destroy(): void {
      abortInFlight();
      generation += 1;
      transcript = [];
      program = null;
      guideError = null;
      suggestedQuestions = [];
      error = null;
      status = "destroyed";
      deps.port.destroy();
      publish();
      listeners.clear();
    },
  };
}
