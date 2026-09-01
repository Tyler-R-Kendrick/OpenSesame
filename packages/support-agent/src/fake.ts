/**
 * The deterministic support agent every other package tests against.
 *
 * There is no module mocking anywhere in this repo, so a fake has to be a real
 * implementation of the port. This one is scripted rather than clever: rules
 * are matched in order, a sequence can be laid out turn by turn to exercise a
 * replan, and the awkward states a real provider actually produces — a model
 * that has not been downloaded, a transport that dies mid-answer, output that
 * is not a program at all — are all reachable from the script.
 */

import {
  type SupportAgentAvailability,
  type SupportAgentPort,
  type SupportComputerStep,
  SupportError,
  type SupportErrorCode,
  type SupportPageContext,
  type SupportRequest,
  type SupportRunOptions,
  type SupportTurn,
  type SupportUnavailableReason,
} from "./contract.js";

export type FakeSupportRule = {
  /** A substring of the question, or a pattern to test it against. */
  readonly match: string | RegExp;
  /** Reported by `availability()` while this rule is the matching one. */
  readonly availability?: SupportAgentAvailability;
  readonly answer: string;
  /** GuideLang source, valid or not — invalid is the interesting case. */
  readonly guide?: string;
  readonly suggestedQuestions?: readonly string[];
  readonly thoughts?: string | null;
  readonly computer?: readonly SupportComputerStep[];
  /** Reject with this code instead of answering. */
  readonly error?: SupportErrorCode;
  /** Never settle until the run's signal aborts, then reject as aborted. */
  readonly abortsMidRun?: boolean;
};

export type FakeSupportScript = {
  readonly rules?: readonly FakeSupportRule[];
  /**
   * Consumed one entry per `run`, ahead of `rules`. This is how a multi-turn
   * replan is written: first turn bad, second turn corrected. The last entry
   * repeats once the sequence runs out.
   */
  readonly sequence?: readonly FakeSupportRule[];
  /** Used when nothing else matches. */
  readonly fallback?: FakeSupportRule;
  /** The agent-wide availability, when no matching rule overrides it. */
  readonly availability?: SupportAgentAvailability;
};

export interface FakeSupportAgent extends SupportAgentPort {
  /** Every request handed to this fake, in order. Retries are visible here. */
  calls(): readonly SupportRequest[];
  destroyed(): boolean;
  setAvailability(availability: SupportAgentAvailability): void;
}

const READY: SupportAgentAvailability = { kind: "ready" };

const DEFAULT_FALLBACK: FakeSupportRule = {
  match: /.*/,
  answer: "I do not have enough of this page's context to answer that.",
};

function matches(rule: FakeSupportRule, question: string): boolean {
  const pattern = rule.match;
  if (pattern instanceof RegExp) return pattern.test(question);
  return question.toLowerCase().includes(pattern.toLowerCase());
}

function turnOf(rule: FakeSupportRule): SupportTurn {
  return {
    answer: rule.answer,
    guide: rule.guide ?? null,
    suggestedQuestions: rule.suggestedQuestions ?? [],
    thoughts: rule.thoughts ?? null,
    computer: rule.computer ?? [],
  };
}

/** Settles only when the caller gives up, which is what a hung provider does. */
function untilAborted(signal: AbortSignal): Promise<never> {
  return new Promise<never>((_resolve, reject) => {
    const fail = (): void => {
      reject(new SupportError("AGENT_ABORTED", "the support run was aborted"));
    };
    if (signal.aborted) {
      fail();
      return;
    }
    signal.addEventListener("abort", fail, { once: true });
  });
}

export function createFakeSupportAgent(
  script: FakeSupportScript,
): FakeSupportAgent {
  const rules = script.rules ?? [];
  const sequence = script.sequence ?? [];
  const fallback = script.fallback ?? DEFAULT_FALLBACK;
  const received: SupportRequest[] = [];
  let availability = script.availability ?? READY;
  let destroyed = false;
  let step = 0;

  function ruleFor(question: string): FakeSupportRule {
    if (sequence.length > 0) {
      const index = Math.min(step, sequence.length - 1);
      const scripted = sequence[index];
      if (scripted !== undefined) return scripted;
    }
    for (const rule of rules) {
      if (matches(rule, question)) return rule;
    }
    return fallback;
  }

  return {
    availability(): Promise<SupportAgentAvailability> {
      if (destroyed) {
        return Promise.resolve({
          kind: "unavailable",
          reason: "no_local_model",
        });
      }
      return Promise.resolve(availability);
    },
    run(
      request: SupportRequest,
      options: SupportRunOptions,
    ): Promise<SupportTurn> {
      received.push(request);
      const rule = ruleFor(request.question);
      step += 1;
      if (destroyed) {
        return Promise.reject(
          new SupportError(
            "AGENT_UNAVAILABLE",
            "this fake agent was destroyed",
          ),
        );
      }
      if (rule.availability !== undefined) availability = rule.availability;
      if (rule.abortsMidRun === true) return untilAborted(options.signal);
      if (options.signal.aborted) {
        return Promise.reject(
          new SupportError("AGENT_ABORTED", "the support run was aborted"),
        );
      }
      const failure = rule.error;
      if (failure !== undefined) {
        return Promise.reject(
          new SupportError(failure, `scripted failure: ${failure}`),
        );
      }
      return Promise.resolve(turnOf(rule));
    },
    destroy(): void {
      destroyed = true;
    },
    calls(): readonly SupportRequest[] {
      return received.slice();
    },
    destroyed(): boolean {
      return destroyed;
    },
    setAvailability(next: SupportAgentAvailability): void {
      availability = next;
    },
  };
}

/** Answers everything the same way. The base case for a UI test. */
export function fakeAgentAnswering(
  answer: string,
  guide?: string,
): FakeSupportAgent {
  const fallback: FakeSupportRule =
    guide === undefined
      ? { match: /.*/, answer }
      : { match: /.*/, answer, guide };
  return createFakeSupportAgent({ fallback });
}

/** A device with no model, or one the person has not downloaded yet. */
export function fakeAgentAlwaysUnavailable(
  reason: SupportUnavailableReason = "no_local_model",
): FakeSupportAgent {
  return createFakeSupportAgent({
    availability: { kind: "unavailable", reason },
  });
}

/** Present, but needs the gesture that starts the download. */
export function fakeAgentDownloadable(): FakeSupportAgent {
  return createFakeSupportAgent({ availability: { kind: "downloadable" } });
}

export function fakeAgentDownloading(progress: number): FakeSupportAgent {
  return createFakeSupportAgent({
    availability: { kind: "downloading", progress },
  });
}

/** Rejects every run with a transport-level failure. */
export function fakeAgentFailing(
  code: SupportErrorCode = "AGENT_PROTOCOL_ERROR",
): FakeSupportAgent {
  return createFakeSupportAgent({
    fallback: { match: /.*/, answer: "", error: code },
  });
}

/** Answers, then hangs until the caller aborts. */
export function fakeAgentHanging(): FakeSupportAgent {
  return createFakeSupportAgent({
    fallback: { match: /.*/, answer: "", abortsMidRun: true },
  });
}

export type FakeReplanStep = {
  readonly answer: string;
  readonly guide?: string;
};

/**
 * One scripted turn per call, the last one repeating. Written for the replan
 * loop: emit a trajectory, observe, emit the next one.
 */
export function fakeAgentReplanning(
  steps: readonly FakeReplanStep[],
): FakeSupportAgent {
  const sequence: FakeSupportRule[] = [];
  for (const entry of steps) {
    sequence.push(
      entry.guide === undefined
        ? { match: /.*/, answer: entry.answer }
        : { match: /.*/, answer: entry.answer, guide: entry.guide },
    );
  }
  return createFakeSupportAgent({ sequence });
}

/**
 * A small, realistic page context for tests in every package that consumes
 * this port. Registry-authored prose, coarse facts, no user data — the same
 * discipline `buildSupportPageContext` follows in the app.
 */
export function fakeSupportPageContext(): SupportPageContext {
  return {
    version: 1,
    pageId: "connections",
    route: "/connections",
    targets: [
      {
        id: "nav.connections",
        description: "The Connections entry in the primary navigation.",
        role: "navigation",
        mounted: true,
      },
      {
        id: "connection.create",
        description: "The control that begins adding a provider connection.",
        role: "action",
        mounted: true,
      },
      {
        id: "connection.confirm",
        description: "The confirmation step of the add-connection ceremony.",
        role: "ceremony",
        mounted: false,
      },
    ],
    routes: [
      { id: "/connections", title: "Connections" },
      { id: "/settings", title: "Settings" },
    ],
    state: [
      { id: "vault.unlocked", value: true },
      { id: "host.reachable", value: false },
    ],
    capabilities: [
      {
        id: "connection.create",
        title: "Create a connection",
        available: true,
      },
      { id: "backup.configure", title: "Configure backup", available: false },
    ],
    goals: [
      { id: "connection.create", title: "Add a provider connection" },
      { id: "vault.unlock", title: "Unlock the vault" },
    ],
  };
}
