/**
 * The provider-neutral contract between OpenSesame's support UI and whatever
 * is answering: the browser's on-device Prompt API, an AG-UI endpoint, or the
 * deterministic fake the tests run against.
 *
 * A `SupportTurn` carries prose and, at most, a GuideLang program. There is no
 * field through which a model can return a tool call, a URL, a selector or an
 * authority mutation — discovering a capability is never authorization to
 * invoke it.
 */

export type SupportUnavailableReason =
  | "no_local_model"
  | "model_not_downloaded"
  | "no_remote_endpoint"
  | "offline"
  | "vault_locked"
  | "platform_unsupported";

export type SupportAgentAvailability =
  | { readonly kind: "unavailable"; readonly reason: SupportUnavailableReason }
  /** Present but needs a user gesture to acquire the on-device model. */
  | { readonly kind: "downloadable" }
  | { readonly kind: "downloading"; readonly progress: number }
  | { readonly kind: "ready" };

export type SupportMessageRole = "user" | "assistant";

export type SupportMessage = {
  readonly role: SupportMessageRole;
  readonly text: string;
  readonly thoughts?: string | null;
  readonly computer?: readonly SupportComputerStep[];
};

export type SupportTargetRole =
  | "navigation"
  | "action"
  | "ceremony"
  | "status"
  | "filter"
  | "surface";

/**
 * A control the model may name. `description` is authored by us and checked in
 * — never scraped from the DOM, and never a user-created label such as a vault
 * item name or folder title.
 */
export type SupportTargetDescription = {
  readonly id: string;
  readonly description: string;
  readonly role: SupportTargetRole;
  readonly mounted: boolean;
};

export type SupportRouteDescription = {
  readonly id: string;
  readonly title: string;
};

/** A coarse yes/no fact. Never carries a value a person typed. */
export type SupportStateFact = {
  readonly id: string;
  readonly value: boolean;
};

export type SupportCapabilityDescription = {
  readonly id: string;
  readonly title: string;
  readonly available: boolean;
};

export type SupportGoalDescription = {
  readonly id: string;
  readonly title: string;
};

/**
 * One entry of the written help, chosen for the question being asked. The
 * prose is checked in beside the app and is the source of truth for how the
 * interface works (ADR 0088 §10); a model is asked to answer *from* these and
 * to say which it used. `goal` names the authored walkthrough that goes with
 * the entry, so an answer can offer it without the model naming one.
 */
export type SupportHelpEntry = {
  readonly id: string;
  readonly title: string;
  readonly answer: string;
  readonly goal: string | null;
};

/**
 * A WebMCP tool this page implements, as metadata. `exposed` says whether the
 * browser at hand actually holds the registration; the description is the
 * one the page registers, authored in-repo. There is no way to call one from
 * here — the list tells a model what the app can do, not how to do it.
 */
export type SupportToolDescription = {
  readonly name: string;
  readonly description: string;
  readonly exposed: boolean;
};

/**
 * Everything the model learns about the page. Built from authored registries,
 * never from `innerText`, form values, vault records or storage.
 */
export type SupportPageContext = {
  readonly version: 1;
  readonly pageId: string;
  readonly route: string;
  readonly targets: readonly SupportTargetDescription[];
  readonly routes: readonly SupportRouteDescription[];
  readonly state: readonly SupportStateFact[];
  readonly capabilities: readonly SupportCapabilityDescription[];
  readonly goals: readonly SupportGoalDescription[];
  /** The written help that applies to the question, best match first. */
  readonly help: readonly SupportHelpEntry[];
  /** The WebMCP tools this page implements right now. */
  readonly tools: readonly SupportToolDescription[];
};

/**
 * Where an answer's procedure came from, decided by the trailing `sources:`
 * line the instruction asks for. `cited` names written-help entries from the
 * context the model said it used; `none` is the model saying nothing written
 * covers the question; `uncited` is a model that named nothing at all, which
 * is the case an answer must be treated as a guess.
 */
export type SupportGrounding =
  | { readonly kind: "cited"; readonly help: readonly SupportHelpEntry[] }
  | { readonly kind: "none" }
  | { readonly kind: "uncited" };

export type SupportRequest = {
  readonly question: string;
  readonly history: readonly SupportMessage[];
  readonly context: SupportPageContext;
};

/**
 * One tool or step the agent reported while answering. Display only: the
 * support port never executes a tool call, and the UI renders these as text.
 */
export type SupportComputerStep = {
  readonly title: string;
  readonly detail: string | null;
};

export type SupportTurn = {
  readonly answer: string;
  /** GuideLang source, still unparsed and still untrusted. */
  readonly guide: string | null;
  readonly suggestedQuestions: readonly string[];
  /** Reasoning the transport surfaced. Collapsed in the UI; never HTML. */
  readonly thoughts?: string | null;
  /** Tool/step names the transport surfaced. Display only; never executed. */
  readonly computer?: readonly SupportComputerStep[];
};

export type SupportRunOptions = {
  readonly signal: AbortSignal;
};

export interface SupportAgentPort {
  availability(): Promise<SupportAgentAvailability>;
  run(
    request: SupportRequest,
    options: SupportRunOptions,
  ): Promise<SupportTurn>;
  /** Drop any provider session and its in-memory transcript. */
  destroy(): void;
}

export type SupportErrorCode =
  | "AGENT_UNAVAILABLE"
  | "AGENT_ABORTED"
  | "AGENT_PROTOCOL_ERROR"
  | "AGENT_OUTPUT_INVALID"
  | "EGRESS_REFUSED"
  | "VAULT_LOCKED";

export class SupportError extends Error {
  readonly code: SupportErrorCode;

  constructor(code: SupportErrorCode, message: string) {
    super(message);
    this.name = "SupportError";
    this.code = code;
  }
}

/** Context budgets — a page context that outgrows these is truncated, not sent. */
export const SUPPORT_LIMITS = {
  maxQuestionChars: 2000,
  maxHistoryTurns: 12,
  maxHistoryMessageChars: 4000,
  maxTargets: 80,
  maxStateFacts: 40,
  // 64, not a round 50: the ADR 0065 registry lists every PWA capability
  // here, and the vault's second-step and recovery-code ceremonies (ADR 0091)
  // took it past 60. Raised deliberately; `withinBudget` throws in
  // development the next time it is outgrown.
  maxCapabilities: 64,
  maxGoals: 40,
  maxRoutes: 32,
  maxHelpEntries: 6,
  maxHelpAnswerChars: 800,
  maxTools: 40,
  maxAnswerChars: 4000,
  maxSuggestedQuestions: 4,
  /** One bounded re-ask when a model returns unparseable GuideLang. */
  maxGuideRepairAttempts: 1,
} as const;
