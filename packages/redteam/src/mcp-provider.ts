/**
 * promptfoo custom provider: the "provider under test" for the three
 * deterministic red-team classes (confused-deputy, credential-exfiltration,
 * malformed-input). No LLM is involved here on purpose — these classes assert
 * on the real, unmodified `apps/mcp-host` server's own behavior (its zod
 * schemas, its `forAgent`/`scrubLocalSecrets` fence, its refusal to let a
 * caller restate an already-frozen intent), not on a model's judgment. See
 * `docs/security/audit-2026-08-08-mcp-agent-boundary.md`,
 * `docs/security/audit-2026-08-08-mcp-endpoint-fences.md`, and
 * `docs/security/audit-2026-08-08-mcp-resource-scope.md` for the bug classes
 * this reproduces.
 *
 * Each `callApi()` invocation:
 *   1. optionally starts a private, ephemeral stub Host API / daemon
 *      (`mock-upstream.ts`) on an OS-assigned port, primed with the response
 *      bodies the test case wants `apps/mcp-host` to receive;
 *   2. spawns the real `apps/mcp-host` server over stdio, mirroring
 *      `apps/mcp-host/src/transports/stdio.ts` from the client side via the
 *      MCP SDK's `StdioClientTransport` (the same package/version mcp-host
 *      itself depends on: @modelcontextprotocol/sdk 1.30.0);
 *   3. makes the sequence of tool calls the test case specifies;
 *   4. returns everything (raw MCP responses, captured upstream requests, and
 *      optionally the live tool schemas) as one JSON string, so assertions can
 *      do exact, structural checks instead of guessing at prose.
 *
 * This never talks to Anthropic and needs no model credentials at all — the
 * three test classes that use this provider run the same whether or not
 * ANTHROPIC_API_KEY or a Claude Code session is available. Only the
 * prompt-injection class (a separate provider — see promptfooconfig.yaml)
 * needs live model access.
 */
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { type JsonObject, isString, overlapCast } from "@opensesame/os-domain";
import {
  type MockRoute,
  type MockUpstream,
  startMockUpstream,
} from "./mock-upstream.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// packages/redteam/src -> packages/redteam -> packages -> repo root -> apps/mcp-host
const MCP_HOST_DIR = path.resolve(__dirname, "../../../apps/mcp-host");
const SERVER_ENTRY = "src/server.ts";

const CONNECT_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 15_000;

interface ToolCallSpec {
  tool: string;
  params: JsonObject;
}

/**
 * The shape of `vars` this provider expects on every test case that targets
 * it. `calls` are made in order against the same live client/task context, so
 * a test can e.g. task_start then task_invoke then operator_invoke_l1 and
 * observe how the frozen intent carries across calls.
 */
export interface RedteamVars {
  calls: ToolCallSpec[];
  /** Canned Host API / daemon responses for this test's private stub. */
  mockRoutes?: MockRoute[];
  /** Extra env vars for the spawned mcp-host process (e.g. a fixture operator token). */
  env?: Record<string, string>;
  /** Also return `tools/list` output, for schema-introspection assertions. */
  includeToolSchemas?: boolean;
}

interface ProviderResponse {
  output?: string;
  error?: string;
}

function processEnvStrings() {
  return Object.fromEntries(
    Object.entries(process.env).filter((entry): entry is [string, string] =>
      isString(entry[1]),
    ),
  );
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error(`timed out after ${ms}ms while ${label}`)),
      ms,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

export default class McpHostStructuralProvider {
  id(): string {
    return "mcp-host-structural";
  }

  async callApi(
    _prompt: string,
    context?: { vars?: JsonObject },
  ): Promise<ProviderResponse> {
    const vars: RedteamVars = overlapCast(context?.vars ?? {});

    if (!Array.isArray(vars.calls) || vars.calls.length === 0) {
      return {
        error:
          "redteam harness misconfigured: test vars must include a non-empty 'calls' array " +
          "of { tool, params } — see packages/redteam/tests/*.yaml for examples.",
      };
    }

    let mock: MockUpstream | undefined;
    let transport: StdioClientTransport | undefined;
    let client: Client | undefined;

    try {
      if (vars.mockRoutes?.length) {
        mock = await startMockUpstream(vars.mockRoutes);
      }

      const env = {
        ...processEnvStrings(),
        ...(vars.env ?? {}),
      };
      env.NODE_OPTIONS = [env.NODE_OPTIONS, "--disable-warning=DEP0205"]
        .filter(Boolean)
        .join(" ");
      if (mock) {
        env.OPENSESAME_SERVER = mock.url;
        env.OPENSESAME_DAEMON_URL = mock.url;
      }

      transport = new StdioClientTransport({
        command: process.execPath,
        args: ["--import", "tsx", SERVER_ENTRY],
        cwd: MCP_HOST_DIR,
        env,
        stderr: "pipe",
      });

      const stderrChunks: string[] = [];
      transport.stderr?.on("data", (chunk: Buffer) =>
        stderrChunks.push(chunk.toString()),
      );

      client = new Client({ name: "opensesame-redteam", version: "0.1.0" });
      await withTimeout(
        client.connect(transport),
        CONNECT_TIMEOUT_MS,
        "connecting to mcp-host",
      );

      const calls: Array<{
        tool: string;
        params: JsonObject;
        response: unknown;
      }> = [];
      for (const call of vars.calls) {
        const response = await withTimeout(
          client.callTool({ name: call.tool, arguments: call.params }),
          CALL_TIMEOUT_MS,
          `calling tool "${call.tool}"`,
        );
        calls.push({ tool: call.tool, params: call.params, response });
      }

      const tools = vars.includeToolSchemas
        ? (await client.listTools()).tools
        : undefined;

      const output = {
        calls,
        tools,
        upstreamRequests: mock?.requests,
        // Included for debugging a failed run; empty on a healthy server.
        serverStderr: stderrChunks.length ? stderrChunks.join("") : undefined,
      };
      return { output: JSON.stringify(output, null, 2) };
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Degrade to a clear, structured provider error rather than hanging or
      // throwing a raw stack trace into the eval — e.g. this fires cleanly if
      // the workspace hasn't been `pnpm install`-ed yet (tsx / the SDK missing).
      return {
        error: `mcp-host structural probe failed: ${message}`,
      };
    } finally {
      try {
        await client?.close();
      } catch {
        // best effort
      }
      try {
        await mock?.close();
      } catch {
        // best effort
      }
    }
  }
}
