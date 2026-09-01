/**
 * The optional remote support agent: an AG-UI endpoint behind the same
 * `SupportAgentPort` the on-device Prompt API implements.
 *
 * Two boundaries meet in this file and neither trusts the other.
 *
 * Outbound, the request is sanitized and then rebuilt into an enumerable
 * envelope, and the envelope is structurally scanned before the transport is
 * even constructed. A refusal happens with nothing on the wire.
 *
 * Inbound, an AG-UI stream is a protocol for driving an application: tool
 * calls, state snapshots, JSON-patch deltas, activity, subagents. This adapter
 * implements assistant text, and *displays* reasoning and tool names as
 * optional traces. It still does not execute a tool call, apply a patch, or
 * reach a Host mutation, a WebMCP tool, a router or the DOM. A server that
 * asks for an action is unheard. The only influence a server has is prose, a
 * GuideLang string, and collapsed traces of how it thought — and the guide
 * string goes to the same parser and validator as every other guide, still
 * untrusted.
 */

import {
  type BoundaryValue,
  type JsonObject,
  type JsonValue,
  isJsonObject,
  overlapCast,
  readString,
} from "@opensesame/os-domain";
import {
  type SupportAgentAvailability,
  type SupportAgentPort,
  type SupportComputerStep,
  SupportError,
  type SupportRequest,
  type SupportRunOptions,
  type SupportTurn,
  assertNoStructuralLeak,
  buildSupportInstructions,
  parseSupportTurn,
  sanitizeSupportRequest,
} from "@opensesame/support-agent";
import { type AgUiEndpoint, currentAgUiEndpoint } from "./endpoint.js";
import { buildAgUiOutboundBody } from "./outbound.js";
import {
  type AgUiTransport,
  type AgUiTransportOptions,
  createAgUiTransport,
} from "./transport.js";

export type AgUiSupportAgentOptions = {
  /** Absent means the remote transport is off. That is the default. */
  readonly endpoint: AgUiEndpoint | null;
  /** Injected in tests; production builds the lazy `@ag-ui/client` one. */
  readonly transport?: AgUiTransport;
  readonly transportOptions?: AgUiTransportOptions;
  readonly online?: () => boolean;
};

/**
 * Matches `parseSupportTurn`'s own ceiling on how much model output is looked
 * at. Reading further would only produce text that is then discarded, and a
 * server that keeps streaming past it is not answering a support question.
 */
const MAX_STREAM_CHARS = 65_536;

/** A stream longer than this is a flood whatever each event contains. */
const MAX_STREAM_EVENTS = 4096;

/** Enough to track the open messages of a real run, not enough to be a leak. */
const MAX_TRACKED_MESSAGES = 256;

function isOnlineDefault(): boolean {
  return globalThis.navigator?.onLine !== false;
}

type TextAccumulator = {
  readonly chunks: string[];
  remaining: number;
  produced: boolean;
};

type TraceAccumulator = {
  readonly thoughts: string[];
  thoughtsRemaining: number;
  readonly computer: SupportComputerStep[];
  openTool: string | null;
};

const MAX_THOUGHT_CHARS = 4000;
const MAX_COMPUTER_STEPS = 8;
const MAX_COMPUTER_TITLE_CHARS = 80;
const MAX_COMPUTER_DETAIL_CHARS = 500;

/**
 * Which open message ids are assistant text. A `TEXT_MESSAGE_START` that
 * declares any other role opens a message whose deltas are dropped — a server
 * cannot smuggle a "system" or "tool" message into the answer by streaming it
 * as text.
 */
type MessageRoles = Map<string, boolean>;

function acceptsDelta(roles: MessageRoles, event: JsonObject): boolean {
  const role = readString(event.role);
  if (role !== undefined && role !== "assistant") return false;
  const id = readString(event.messageId);
  if (id === undefined) return true;
  return roles.get(id) !== false;
}

function rememberRole(roles: MessageRoles, event: JsonObject): void {
  const id = readString(event.messageId);
  if (id === undefined) return;
  if (!roles.has(id) && roles.size >= MAX_TRACKED_MESSAGES) return;
  const role = readString(event.role);
  roles.set(id, role === undefined || role === "assistant");
}

function appendDelta(text: TextAccumulator, event: JsonObject): void {
  const delta = readString(event.delta);
  if (delta === undefined || text.remaining <= 0) return;
  const slice =
    delta.length > text.remaining ? delta.slice(0, text.remaining) : delta;
  if (slice.length === 0) return;
  text.chunks.push(slice);
  text.remaining -= slice.length;
  text.produced = true;
}

function appendThought(
  traces: TraceAccumulator,
  delta: string | undefined,
): void {
  if (delta === undefined || traces.thoughtsRemaining <= 0) return;
  const slice =
    delta.length > traces.thoughtsRemaining
      ? delta.slice(0, traces.thoughtsRemaining)
      : delta;
  if (slice.length === 0) return;
  traces.thoughts.push(slice);
  traces.thoughtsRemaining -= slice.length;
}

function clampLabel(value: string, max: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= max) return trimmed;
  return trimmed.slice(0, max);
}

function rememberComputer(
  traces: TraceAccumulator,
  title: string | undefined,
  detail: string | undefined,
): void {
  if (traces.computer.length >= MAX_COMPUTER_STEPS) return;
  const name = clampLabel(title ?? "", MAX_COMPUTER_TITLE_CHARS);
  if (name.length === 0) return;
  const note =
    detail === undefined || detail.trim().length === 0
      ? null
      : clampLabel(detail, MAX_COMPUTER_DETAIL_CHARS);
  traces.computer.push({ title: name, detail: note });
}

/**
 * `true` when the stream should stop being read.
 *
 * Assistant text is the answer. Reasoning and tool *names* are collected as
 * traces for the UI. Every other event family — `STATE_*`, `MESSAGES_SNAPSHOT`,
 * `CUSTOM`, `RAW`, `ACTIVITY_*`, `SUBAGENT_*`, tool arguments — is discarded.
 * Tool calls are never executed.
 */
function consumeEvent(
  event: JsonObject,
  roles: MessageRoles,
  text: TextAccumulator,
  traces: TraceAccumulator,
): boolean {
  switch (readString(event.type)) {
    case "TEXT_MESSAGE_START":
      rememberRole(roles, event);
      return false;
    case "TEXT_MESSAGE_CHUNK":
      rememberRole(roles, event);
      if (acceptsDelta(roles, event)) appendDelta(text, event);
      return false;
    case "TEXT_MESSAGE_CONTENT":
      if (acceptsDelta(roles, event)) appendDelta(text, event);
      return false;
    case "REASONING_MESSAGE_START":
    case "THINKING_START":
      return false;
    case "REASONING_MESSAGE_CHUNK":
    case "REASONING_MESSAGE_CONTENT":
    case "THINKING_CONTENT":
      appendThought(
        traces,
        readString(event.delta) ?? readString(event.content),
      );
      return false;
    case "TOOL_CALL_START":
      traces.openTool =
        readString(event.toolCallName) ??
        readString(event.name) ??
        traces.openTool;
      return false;
    case "TOOL_CALL_END":
    case "TOOL_CALL_RESULT":
      // Names only. Arguments and results are untrusted payload and are
      // never shown — a server that "returns" a secret must not get it onto
      // the page through the computer trace.
      rememberComputer(
        traces,
        traces.openTool ??
          readString(event.toolCallName) ??
          readString(event.name),
        undefined,
      );
      traces.openTool = null;
      return false;
    case "STEP_STARTED":
    case "STEP_FINISHED":
      rememberComputer(
        traces,
        readString(event.stepName) ?? readString(event.name),
        readString(event.status),
      );
      return false;
    case "RUN_ERROR":
      throw new SupportError(
        "AGENT_PROTOCOL_ERROR",
        "the support endpoint reported a failed run",
      );
    case "RUN_FINISHED":
      return true;
    default:
      return false;
  }
}

function abortPromise(signal: AbortSignal): Promise<null> {
  return new Promise((settle) => {
    if (signal.aborted) {
      settle(null);
      return;
    }
    signal.addEventListener("abort", () => settle(null), { once: true });
  });
}

function aborted(): SupportError {
  return new SupportError("AGENT_ABORTED", "the support request was cancelled");
}

/**
 * Drain the stream into assistant text.
 *
 * The pull is raced against the abort so a server that simply stops sending
 * cannot hold a cancelled run open, and the iterator is closed on the way out
 * so anything already in flight is dropped rather than appended.
 */
type CollectedStream = {
  readonly text: string;
  readonly thoughts: string | null;
  readonly computer: readonly SupportComputerStep[];
};

async function collectAssistantText(
  stream: AsyncIterable<JsonValue>,
  signal: AbortSignal,
): Promise<CollectedStream> {
  const iterator = stream[Symbol.asyncIterator]();
  const cancelled = abortPromise(signal);
  const roles: MessageRoles = new Map();
  const text: TextAccumulator = {
    chunks: [],
    remaining: MAX_STREAM_CHARS,
    produced: false,
  };
  const traces: TraceAccumulator = {
    thoughts: [],
    thoughtsRemaining: MAX_THOUGHT_CHARS,
    computer: [],
    openTool: null,
  };
  let seen = 0;
  try {
    for (;;) {
      if (signal.aborted) throw aborted();
      const step = await Promise.race([iterator.next(), cancelled]);
      if (step === null || signal.aborted) throw aborted();
      if (step.done === true) break;
      seen += 1;
      if (seen > MAX_STREAM_EVENTS) break;
      const event: JsonValue = step.value;
      if (!isJsonObject(event)) continue;
      if (consumeEvent(event, roles, text, traces)) break;
      if (text.remaining <= 0) break;
    }
  } finally {
    // Not awaited: a stream that stopped answering would otherwise hold a
    // cancelled run open at exactly the moment it is being cancelled.
    iterator.return?.().catch(() => undefined);
  }
  if (!text.produced) {
    throw new SupportError(
      "AGENT_PROTOCOL_ERROR",
      "the support endpoint ended the stream without an assistant message",
    );
  }
  const thoughts = traces.thoughts.join("").trim();
  return {
    text: text.chunks.join(""),
    thoughts: thoughts.length > 0 ? thoughts : null,
    computer: traces.computer,
  };
}

export function createAgUiSupportAgent(
  options: AgUiSupportAgentOptions,
): SupportAgentPort {
  const endpoint = options.endpoint;
  const online = options.online ?? isOnlineDefault;
  const transport =
    options.transport ?? createAgUiTransport(options.transportOptions ?? {});
  let active: AbortController | null = null;

  return {
    async availability(): Promise<SupportAgentAvailability> {
      if (endpoint === null) {
        return { kind: "unavailable", reason: "no_remote_endpoint" };
      }
      if (!online()) return { kind: "unavailable", reason: "offline" };
      return { kind: "ready" };
    },

    async run(
      request: SupportRequest,
      runOptions: SupportRunOptions,
    ): Promise<SupportTurn> {
      if (endpoint === null) {
        throw new SupportError(
          "AGENT_UNAVAILABLE",
          "no remote support endpoint is configured",
        );
      }
      if (!online()) {
        throw new SupportError(
          "AGENT_UNAVAILABLE",
          "this device reports no network connection",
        );
      }

      const sanitized = sanitizeSupportRequest(request);
      const body = buildAgUiOutboundBody(
        sanitized,
        buildSupportInstructions(sanitized.context),
      );
      // SAFETY: the body was rebuilt field by field from validated primitives
      // immediately above, so it already is the JSON structure BoundaryValue
      // names; the scan below is what proves it before anything is sent.
      const payload: BoundaryValue = overlapCast(body);
      assertNoStructuralLeak(payload);

      const controller = new AbortController();
      active = controller;
      const forward = (): void => controller.abort();
      if (runOptions.signal.aborted) controller.abort();
      else runOptions.signal.addEventListener("abort", forward, { once: true });

      try {
        const raw = await collectAssistantText(
          transport({ endpoint, body, signal: controller.signal }),
          controller.signal,
        );
        if (controller.signal.aborted) throw aborted();
        const parsed = parseSupportTurn(raw.text);
        return {
          ...parsed,
          thoughts: raw.thoughts,
          computer: raw.computer,
        };
      } catch (caught) {
        if (controller.signal.aborted) throw aborted();
        if (caught instanceof SupportError) throw caught;
        // A transport failure carries a server-authored message. It is
        // deliberately not propagated: this error is rendered, and rendering
        // attacker prose as OpenSesame's own diagnostic is how a support panel
        // becomes a phishing surface.
        throw new SupportError(
          "AGENT_PROTOCOL_ERROR",
          "the support endpoint could not be reached",
        );
      } finally {
        runOptions.signal.removeEventListener("abort", forward);
        controller.abort();
        if (active === controller) active = null;
      }
    },

    destroy(): void {
      active?.abort();
      active = null;
    },
  };
}

/**
 * The app-facing constructor: this deployment's remote agent, or `null` when
 * nobody configured one.
 *
 * `null` rather than a port that always refuses, because the caller uses the
 * difference: a null here is "there is no remote transport", which is what
 * decides whether the panel says prompts leave the device at all.
 */
export function createAgUiAgent(): SupportAgentPort | null {
  const endpoint = currentAgUiEndpoint();
  return endpoint === null ? null : createAgUiSupportAgent({ endpoint });
}
