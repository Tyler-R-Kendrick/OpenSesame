/**
 * Privacy-bounded telemetry for the mcp-host tool surface. Off by default:
 * everything below is a no-op unless `OPENSESAME_TELEMETRY_KEY` is set.
 *
 * Approach: `McpServer.tool(...)` has no central dispatch point to hook —
 * each tool is registered with its own call to `server.tool(name, ..., cb)`
 * (see `./tools.ts`). So instead of touching every call site, this module
 * monkey-patches `server.tool` itself, once, before `registerHostTools(server)`
 * runs: every tool registered afterward has its handler transparently wrapped
 * with timing + a single `mcp_tool_call` telemetry event. `server.ts` calls
 * `wrapServerWithTelemetry(server)` immediately before `registerHostTools(server)`
 * — that is the only edit made to `server.ts`.
 */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { type Telemetry, createTelemetry } from "@opensesame/telemetry";
import { PostHog } from "posthog-node";

const DEFAULT_POSTHOG_HOST = "https://us.i.posthog.com";

/**
 * The PostHog Node SDK requires a `distinctId` on every `capture()` call —
 * unlike posthog-js in the browser, it does not assign one for you. This id
 * is generated once per process, held only in memory, never persisted to
 * disk, and never paired with an `identify()` call (there is none anywhere
 * in this module) — so it does not name a person, account, or device, only
 * "some mcp-host process ran during this run".
 */
const ANONYMOUS_DISTINCT_ID = crypto.randomUUID();

let posthogClient: PostHog | undefined;
let shutdownHooked = false;

function getPosthogClient(): PostHog | undefined {
  const key = process.env.OPENSESAME_TELEMETRY_KEY;
  if (!key) return undefined;
  if (!posthogClient) {
    posthogClient = new PostHog(key, {
      host: process.env.OPENSESAME_TELEMETRY_HOST || DEFAULT_POSTHOG_HOST,
    });
    hookShutdown(posthogClient);
  }
  return posthogClient;
}

/** Flush pending events before the process exits, not after. */
function hookShutdown(client: PostHog): void {
  if (shutdownHooked) return;
  shutdownHooked = true;
  const flush = () => {
    void client.shutdown().catch(() => {
      // Best-effort flush — a failure here must not stop process shutdown.
    });
  };
  process.on("SIGINT", flush);
  process.on("SIGTERM", flush);
}

/**
 * Builds the default (env-driven) telemetry instance, or `undefined` when
 * `OPENSESAME_TELEMETRY_KEY` is unset — the caller's job is to treat
 * `undefined` as "skip wrapping entirely".
 */
function createHostTelemetry(): Telemetry | undefined {
  const client = getPosthogClient();
  if (!client) return undefined;
  return createTelemetry({
    capture(event, props) {
      client.capture({
        distinctId: ANONYMOUS_DISTINCT_ID,
        event,
        properties: props,
      });
    },
  });
}

type AnyFn = (...args: unknown[]) => unknown;

/**
 * Narrow structural view of `McpServer` used only for the monkey-patch. The
 * real `server.tool` has six overloaded call signatures (see
 * `@modelcontextprotocol/sdk`'s `mcp.d.ts`); assigning a single-signature
 * replacement function to a property typed with all six is not something
 * TypeScript allows directly, so the patch goes through this narrower,
 * structurally-compatible view instead of the real (overloaded) type. The
 * important invariant across every one of the SDK's `tool()` overloads is
 * that the callback is always the *last* argument — that's the only thing
 * this module relies on.
 */
interface ToolRegistrar {
  tool: AnyFn;
}

/**
 * CallToolResult shape this module reads (never writes). Only used to derive
 * the `outcome` classification below — the actual `content`/`isError` value
 * returned to the MCP client is untouched and unread by telemetry beyond
 * this classification step.
 */
interface ToolResultLike {
  isError?: boolean;
  content?: unknown;
}

function isToolResultLike(value: unknown): value is ToolResultLike {
  return typeof value === "object" && value !== null && "content" in value;
}

function resultText(result: ToolResultLike): string {
  const content = result.content;
  if (!Array.isArray(content)) return "";
  return content
    .map((block) =>
      block && typeof block === "object" && "text" in block
        ? String((block as { text: unknown }).text)
        : "",
    )
    .join(" ");
}

/**
 * Classifies a successful (non-throwing) tool call. `"refused"` covers this
 * server's own deliberate "no" paths — `task_context_required`,
 * `secret_tools_forbidden`, `materialize_denied`, and similar wording from
 * `tools.ts`'s `toolError()` helper and `operator_invoke_l1`'s explicit
 * denial check read as an authoritative refusal rather than an unexpected
 * failure. Anything else with `isError: true` is a generic `"error"`.
 *
 * The result text is inspected only to derive this three-way label and is
 * then discarded — it is never itself included in the telemetry payload,
 * satisfying "never include tool results" while still letting refusals be
 * told apart from failures.
 */
function classifyOutcome(result: unknown): "ok" | "error" | "refused" {
  if (!isToolResultLike(result) || !result.isError) return "ok";
  const text = resultText(result).toLowerCase();
  return /denied|forbidden|refused|unauthorized|required|not[_-]?permitted/.test(
    text,
  )
    ? "refused"
    : "error";
}

function safeTrack(
  telemetry: Telemetry,
  event: string,
  props: Record<string, unknown>,
): void {
  try {
    telemetry.track(event, props);
  } catch {
    // Telemetry must never take down a tool call — swallow and move on.
  }
}

function wrapToolHandler(
  server: McpServer,
  name: string,
  handler: AnyFn,
  telemetry: Telemetry,
): AnyFn {
  return async (...cbArgs: unknown[]) => {
    // `getClientVersion()` reflects the client info negotiated during the
    // MCP `initialize` handshake and is available per-call on the
    // underlying `Server` (`McpServer.server`) — no fallback to a static
    // "unknown" is needed here, unlike the case where this isn't exposed.
    const clientInfo = server.server.getClientVersion();
    const client = clientInfo?.name ?? "unknown";
    const start = Date.now();

    try {
      const result = await handler(...cbArgs);
      safeTrack(telemetry, "mcp_tool_call", {
        tool: name,
        duration_ms: Date.now() - start,
        outcome: classifyOutcome(result),
        client,
      });
      return result;
    } catch (e) {
      safeTrack(telemetry, "mcp_tool_call", {
        tool: name,
        duration_ms: Date.now() - start,
        outcome: "error",
        // constructor.name only — never `.message`, which can carry a URL,
        // a header, or a quoted request body (see tools.ts's toolError()).
        error_class: e instanceof Error ? e.constructor.name : "UnknownError",
        client,
      });
      throw e;
    }
  };
}

/**
 * Patches `server.tool` so every tool registered *after* this call emits a
 * `mcp_tool_call` telemetry event around its handler. Call this once, before
 * `registerHostTools(server)`.
 *
 * Pass `telemetry` explicitly for tests (a stubbed `capture`); omitted, it is
 * built from `OPENSESAME_TELEMETRY_KEY`/`OPENSESAME_TELEMETRY_HOST`. Either
 * way, when there is no telemetry to send (`telemetry` omitted and the env
 * key unset), this function does not touch `server.tool` at all — tool
 * registration behaves exactly as if telemetry did not exist.
 */
export function wrapServerWithTelemetry(
  server: McpServer,
  telemetry?: Telemetry,
): void {
  const active = telemetry ?? createHostTelemetry();
  if (!active) return;

  // SAFETY: ToolRegistrar is the structural subset of McpServer.tool used
  // for the last-argument callback wrap; the SDK's overloads cannot be named.
  const target = server as ToolRegistrar;
  const originalTool = target.tool.bind(target);

  target.tool = (...args: unknown[]) => {
    const name = args[0];
    const lastIndex = args.length - 1;
    const handler = args[lastIndex];
    if (typeof name !== "string" || typeof handler !== "function") {
      // Every `tool()` overload ends in a callback, so this should not
      // happen; fall through untouched rather than guess at a shape we
      // don't recognize.
      return originalTool(...args);
    }
    const patchedArgs = [...args];
    patchedArgs[lastIndex] = wrapToolHandler(
      server,
      name,
      handler as AnyFn,
      active,
    );
    return originalTool(...patchedArgs);
  };
}
