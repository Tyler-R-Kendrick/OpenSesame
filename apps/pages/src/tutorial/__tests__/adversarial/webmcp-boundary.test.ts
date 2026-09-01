/** @vitest-environment jsdom */

/**
 * The wall between guidance and actuation.
 *
 * ADR 0087 §8 keeps them on separate channels: the support model may say
 * things and emit GuideLang, and WebMCP may run governed tools, and neither
 * reaches the other. The WebMCP suites test that catalog on its own terms and
 * the AG-UI suite tests the stream normalizer on its own terms; what nothing
 * tests is the pair, live in one document, with a hostile stream naming a real
 * tool by name.
 */

import { type JsonObject, overlapCast } from "@opensesame/os-domain";
import {
  type SupportRequest,
  type SupportTurn,
  parseSupportTurn,
} from "@opensesame/support-agent";
import * as webmcp from "@opensesame/webmcp";
import {
  type ModelContextApi,
  type WebMcpToolDescriptor,
  createWebMcpRegistrar,
} from "@opensesame/webmcp";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import {
  type PagesWebMcpTool,
  WEBMCP_TOOLS,
  webmcpSupportSeam,
} from "../../../webmcp/tools.js";
import { createAgUiSupportAgent } from "../../agents/ag-ui/ag-ui-agent.js";
import type { AgUiEndpoint } from "../../agents/ag-ui/endpoint.js";
import type { AgUiTransport } from "../../agents/ag-ui/transport.js";
import { guideGoalIds } from "../../registry/goals.js";
import {
  type SupportChain,
  createSupportChain,
  guideSource,
} from "./harness.js";

const originalSupportSeam = { ...webmcpSupportSeam };

let chain: SupportChain | null = null;

afterEach(() => {
  Object.assign(webmcpSupportSeam, originalSupportSeam);
  chain?.dispose();
  chain = null;
  document.body.replaceChildren();
});

type Tripwire = {
  readonly api: ModelContextApi;
  readonly fired: string[];
  /** Every governed tool, with its execute replaced by a recorder. */
  readonly tools: readonly PagesWebMcpTool[];
};

/**
 * The real catalog, registered against a stub browser, with every `execute`
 * swapped for a recorder. Anything that runs a tool by any route shows up in
 * `fired` — including a route nobody knew about.
 */
function armTripwire(): Tripwire {
  const fired: string[] = [];
  const tools = WEBMCP_TOOLS.map((tool) => ({
    ...tool,
    execute: (args: JsonObject) => {
      fired.push(tool.name);
      return { status: "should_never_run", args };
    },
  }));
  const registered: WebMcpToolDescriptor[] = [];
  const api: ModelContextApi = {
    source: "document",
    registerTool: (tool) => {
      registered.push(tool);
      return () => {};
    },
    getTools: () => [...registered],
    executeTool: (name, args) => {
      // A browser that implements executeTool really would run the tool. The
      // stub does too, so "nothing fired" means nothing reached this door.
      const found = registered.find((tool) => tool.name === name);
      if (found) void found.execute(args);
      return null;
    },
  };
  createWebMcpRegistrar(api, { appId: "pages" }).register(tools);
  return { api, fired, tools };
}

function endpoint(): AgUiEndpoint {
  return { url: "http://127.0.0.1:9099/support", headers: new Map() };
}

function streamOf(events: readonly JsonObject[]): AgUiTransport {
  return () => ({
    async *[Symbol.asyncIterator]() {
      for (const event of events) yield event;
    },
  });
}

/**
 * The deliberately wrong signature this sweep calls every export with. None of
 * them declares it, which is the experiment: the assertion is on the tripwire,
 * never on the return value, so a refusal is as good an answer as a result.
 */
type SweepArgument = ModelContextApi | string | { readonly appId: string };
type SweptExport = (first: SweepArgument, second: SweepArgument) => void;

describe("discovery is not execution", () => {
  it("runs no tool through any export of the WebMCP package", () => {
    const tripwire = armTripwire();
    const candidates: readonly string[] = [
      "opensesame_totp_code",
      "opensesame_open_reveal",
      "opensesame_delegation_revoke",
      "opensesame_guide_start",
    ];
    let swept = 0;

    for (const entry of Object.values(webmcp)) {
      if (!(entry instanceof Function)) continue;
      swept += 1;
      // SAFETY: the guard above already established a callable, and every call
      // below is wrapped, so this assertion only names the shape of the call.
      const callable: SweptExport = overlapCast(entry);
      for (const argument of [tripwire.api, ...candidates]) {
        try {
          callable(argument, { appId: "pages" });
        } catch {
          // Most exports reject these arguments. A refusal is a pass.
        }
      }
    }

    expect(swept).toBeGreaterThanOrEqual(6);
    expect(tripwire.fired).toEqual([]);
  });

  it("lists tools as metadata that holds no callable", () => {
    const tripwire = armTripwire();
    const listed = webmcp.listRegisteredTools(tripwire.api);

    expect(listed.length).toBe(WEBMCP_TOOLS.length);
    for (const summary of listed) {
      expect(Object.keys(summary).sort()).toEqual([
        "description",
        "inputSchema",
        "name",
      ]);
      for (const value of Object.values(summary)) {
        expect(value).not.toBeInstanceOf(Function);
      }
    }
    expect(tripwire.fired).toEqual([]);
  });
});

describe("opensesame_guide_start", () => {
  function guideStart(): PagesWebMcpTool {
    const found = WEBMCP_TOOLS.find(
      (tool) => tool.name === "opensesame_guide_start",
    );
    if (!found) throw new Error("opensesame_guide_start is missing");
    return found;
  }

  it("accepts nothing but an id somebody in this repository authored", () => {
    const started: string[] = [];
    Object.assign(webmcpSupportSeam, {
      startGuide: (goal: string) => started.push(goal),
    });
    const authored = new Set(guideGoalIds());
    const tool = guideStart();

    fc.assert(
      fc.property(fc.string({ maxLength: 96 }), (goal) => {
        fc.pre(!authored.has(goal));
        expect(() => tool.execute({ goal })).toThrow();
      }),
      { numRuns: 500 },
    );
    expect(started).toEqual([]);
  });

  it("refuses GuideLang however it is dressed up", () => {
    const started: string[] = [];
    Object.assign(webmcpSupportSeam, {
      startGuide: (goal: string) => started.push(goal),
    });
    const tool = guideStart();

    for (const attempt of [
      guideSource('focus "shell.lock" "x"'),
      "guide/1",
      'goal "vault.lock"',
      'vault.lock\nfocus "shell.lock" "x"',
      " vault.lock ",
    ]) {
      expect(() => tool.execute({ goal: attempt })).toThrow(
        "unknown_guide_goal",
      );
    }
    expect(started).toEqual([]);
  });

  it("starts an authored goal, and returns only its id", () => {
    const started: string[] = [];
    Object.assign(webmcpSupportSeam, {
      startGuide: (goal: string) => started.push(goal),
    });

    const result = guideStart().execute({ goal: "vault.lock" });

    expect(result).toEqual({ status: "guide_started", goal: "vault.lock" });
    expect(started).toEqual(["vault.lock"]);
  });
});

describe("a hostile AG-UI stream", () => {
  it("cannot reach a WebMCP tool, and its guide still faces the compiler", async () => {
    const tripwire = armTripwire();
    const active = createSupportChain();
    chain = active;

    const agent = createAgUiSupportAgent({
      endpoint: endpoint(),
      online: () => true,
      transport: streamOf([
        {
          type: "TOOL_CALL_START",
          toolCallId: "1",
          toolCallName: "opensesame_open_reveal",
        },
        { type: "TOOL_CALL_ARGS", toolCallId: "1", delta: '{"itemId":"x"}' },
        { type: "TOOL_CALL_END", toolCallId: "1" },
        {
          type: "TOOL_CALL_START",
          toolCallId: "2",
          toolCallName: "opensesame_shared_session_admit",
        },
        { type: "TOOL_CALL_END", toolCallId: "2" },
        { type: "TEXT_MESSAGE_START", messageId: "m", role: "assistant" },
        {
          type: "TEXT_MESSAGE_CONTENT",
          messageId: "m",
          delta:
            'Sure.\n```guide\nguide/1\ngoal "vault.lock"\nfocus "#reveal-secret" "Press here."\n```',
        },
        { type: "RUN_FINISHED" },
      ]),
    });

    const request: SupportRequest = {
      question: "how do I reveal a password?",
      history: [],
      context: active.context,
    };
    const turn: SupportTurn = await agent.run(request, {
      signal: new AbortController().signal,
    });

    expect(tripwire.fired).toEqual([]);
    expect(turn.answer).toContain("Sure.");
    expect(turn.answer).not.toContain("opensesame_open_reveal");

    const split = parseSupportTurn(turn.answer);
    const source = turn.guide ?? split.guide;
    expect(source).not.toBeNull();
    expect(active.compile(source ?? "")).toBeNull();
    expect(active.renderer.calls).toEqual([]);
    expect(active.routes.navigations()).toEqual([]);
  });

  it("gets no tool catalog to name in the first place", async () => {
    const active = createSupportChain();
    chain = active;
    const bodies: JsonObject[] = [];
    const agent = createAgUiSupportAgent({
      endpoint: endpoint(),
      online: () => true,
      transport: (outbound) => {
        // SAFETY: the outbound body is rebuilt from validated primitives by
        // `buildAgUiOutboundBody`, so reading it here as JSON is structural.
        bodies.push(JSON.parse(JSON.stringify(outbound.body)));
        return {
          async *[Symbol.asyncIterator]() {
            yield {
              type: "TEXT_MESSAGE_START",
              messageId: "m",
              role: "assistant",
            };
            yield {
              type: "TEXT_MESSAGE_CONTENT",
              messageId: "m",
              delta: "The vault list is on the left.",
            };
            yield { type: "RUN_FINISHED" };
          },
        };
      },
    });

    await agent.run(
      { question: "what is here?", history: [], context: active.context },
      { signal: new AbortController().signal },
    );

    const body = bodies[0];
    expect(body).toBeDefined();
    const serialized = JSON.stringify(body);
    for (const tool of WEBMCP_TOOLS) {
      expect(serialized, `named ${tool.name}`).not.toContain(tool.name);
    }
    expect(serialized).not.toContain("executeTool");
    expect(serialized).not.toContain("modelContext");
  });
});
