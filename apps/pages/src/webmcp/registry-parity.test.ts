import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CAPABILITIES,
  assertsNoSecretNames,
  webmcpPagesCatalog,
} from "@opensesame/capability-registry";
import {
  type BoundaryValue,
  type JsonObject,
  overlapCast,
} from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { HELP_TOPICS, guideGoalIds } from "../tutorial/registry/goals.js";
import {
  type PagesWebMcpTool,
  SECTION_PATHS,
  WEBMCP_TOOLS,
  type WebMcpSupportSeam,
  webmcpSupportSeam,
} from "./tools.js";

const here = dirname(fileURLToPath(import.meta.url));

const KNOWN_ROUTES = new Set<string>(["/", ...SECTION_PATHS]);

const LIB_SURFACE = /^lib\/(.+\.ts):(\w+)$/;

const libModules = import.meta.glob("../lib/**/*.ts");

describe("WebMCP registry parity (ADR 0065)", () => {
  it("implements exactly the registry-derived pages catalog", () => {
    const implemented = new Set(WEBMCP_TOOLS.map((tool) => tool.name));
    expect(implemented).toEqual(new Set(webmcpPagesCatalog()));
    expect(WEBMCP_TOOLS.length).toBe(implemented.size);
  });

  it("contains no secret-shaped tool name", () => {
    assertsNoSecretNames(WEBMCP_TOOLS.map((tool) => tool.name));
  });

  it("every lib/<file>.ts:<export> pwa surface resolves to a real export", async () => {
    const surfaces = CAPABILITIES.flatMap((capability) => {
      const match = capability.surfaces.pwa?.match(LIB_SURFACE);
      return match?.[1] && match[2]
        ? [{ id: capability.id, file: match[1], name: match[2] }]
        : [];
    });
    expect(surfaces.length).toBeGreaterThan(0);
    for (const surface of surfaces) {
      const load = libModules[`../lib/${surface.file}`];
      expect(
        load,
        `${surface.id} names missing module lib/${surface.file}`,
      ).toBeDefined();
      if (!load) continue;
      const module: JsonObject = overlapCast(await load());
      expect(
        surface.name in module,
        `${surface.id} names missing export lib/${surface.file}:${surface.name}`,
      ).toBe(true);
    }
  });

  it("every route: pwa surface is a real section route", () => {
    for (const capability of CAPABILITIES) {
      const surface = capability.surfaces.pwa;
      if (!surface?.startsWith("route:")) continue;
      const route = surface.slice("route:".length);
      expect(
        KNOWN_ROUTES.has(route),
        `${capability.id} names unknown route ${route}`,
      ).toBe(true);
    }
  });

  it("SECTION_PATHS mirrors the AppShell SECTIONS const", () => {
    const source = readFileSync(
      join(here, "..", "components", "AppShell.tsx"),
      "utf8",
    );
    for (const path of SECTION_PATHS) {
      expect(source).toContain(`to: "${path}"`);
    }
  });

  it("each pages capability is carried by the tool the registry names", () => {
    const byName = new Map(WEBMCP_TOOLS.map((tool) => [tool.name, tool]));
    for (const capability of CAPABILITIES) {
      const name = capability.surfaces.webmcp;
      if (!name || capability.surfaces.pwa?.startsWith("pwa-app:")) continue;
      const tool = byName.get(name);
      expect(tool, `no tool implements ${name}`).toBeDefined();
      expect(
        tool?.capabilityIds,
        `${name} does not declare ${capability.id}`,
      ).toContain(capability.id);
    }
  });
});

/**
 * The guidance tools are the surface an external browser agent reaches, so
 * these cover the two properties ADR 0087 rests on: a caller may name an
 * authored topic or goal and nothing else, and what comes back is that name
 * plus a fixed status — never a vault row, a secret, or a label a person wrote.
 */
describe("in-product guidance tools (ADR 0087)", () => {
  const GUIDANCE_NAMES = ["opensesame_help", "opensesame_guide_start"];

  const AUTHORED_STRINGS = new Set<string>([
    "support_opened",
    "guide_started",
    ...HELP_TOPICS.map((topic) => topic.id),
    ...guideGoalIds(),
  ]);

  const calls: string[] = [];
  const original: WebMcpSupportSeam = {
    openSupport: webmcpSupportSeam.openSupport,
    startGuide: webmcpSupportSeam.startGuide,
  };

  function guidanceTool(name: string): PagesWebMcpTool {
    const found = WEBMCP_TOOLS.find((candidate) => candidate.name === name);
    if (!found) throw new Error(`no such tool ${name}`);
    return found;
  }

  /** Async so a synchronous refusal reaches the assertion as a rejection. */
  async function invoke(
    name: string,
    args: JsonObject,
  ): Promise<BoundaryValue> {
    return await guidanceTool(name).execute(args);
  }

  async function payload(name: string, args: JsonObject): Promise<JsonObject> {
    const parsed: JsonObject = JSON.parse(
      JSON.stringify(await invoke(name, args)),
    );
    return parsed;
  }

  beforeEach(() => {
    calls.length = 0;
    webmcpSupportSeam.openSupport = (topic) => {
      calls.push(`openSupport:${topic ?? ""}`);
    };
    webmcpSupportSeam.startGuide = (goal) => {
      calls.push(`startGuide:${goal}`);
    };
  });

  afterEach(() => {
    webmcpSupportSeam.openSupport = original.openSupport;
    webmcpSupportSeam.startGuide = original.startGuide;
  });

  it("are session-scoped and carry the capabilities the registry names", () => {
    for (const name of GUIDANCE_NAMES) {
      expect(guidanceTool(name).scope).toBe("session");
    }
    expect(guidanceTool("opensesame_help").capabilityIds).toEqual([
      "client.support",
    ]);
    expect(guidanceTool("opensesame_guide_start").capabilityIds).toEqual([
      "client.tutorial",
    ]);
  });

  it("neither guidance tool name trips the secret-name fence", () => {
    expect(() => assertsNoSecretNames(GUIDANCE_NAMES)).not.toThrow();
  });

  it("opensesame_help opens on an authored topic, or on none at all", async () => {
    expect(HELP_TOPICS.length).toBeGreaterThan(0);
    for (const topic of HELP_TOPICS) {
      await expect(
        invoke("opensesame_help", { topic: topic.id }),
      ).resolves.toEqual({ status: "support_opened", topic: topic.id });
    }
    await expect(invoke("opensesame_help", {})).resolves.toEqual({
      status: "support_opened",
      topic: null,
    });
    expect(calls).toEqual([
      ...HELP_TOPICS.map((topic) => `openSupport:${topic.id}`),
      "openSupport:",
    ]);
  });

  it("opensesame_help rejects a topic nobody authored", async () => {
    for (const topic of [
      "help.not-a-topic",
      "master password",
      "../lib/vault/store.ts",
      "<script>alert(1)</script>",
    ]) {
      await expect(invoke("opensesame_help", { topic })).rejects.toThrow(
        "unknown_help_topic",
      );
    }
    expect(calls).toEqual([]);
  });

  it("opensesame_guide_start starts a named goal", async () => {
    const goals = guideGoalIds();
    expect(goals.length).toBeGreaterThan(0);
    for (const goal of goals) {
      await expect(invoke("opensesame_guide_start", { goal })).resolves.toEqual(
        { status: "guide_started", goal },
      );
    }
    expect(calls).toEqual(goals.map((goal) => `startGuide:${goal}`));
  });

  it("opensesame_guide_start refuses an unnamed goal and any GuideLang text", async () => {
    for (const goal of [
      "vault.unlock",
      "",
      'guide/1\ngoal "x"',
      'focus "#x" "y"',
      'guide/1\ngoal "vault.lock"\nnavigate "/settings"\nend',
      'navigate "/settings"',
    ]) {
      await expect(invoke("opensesame_guide_start", { goal })).rejects.toThrow(
        /unknown_guide_goal|missing_argument:goal/,
      );
    }
    expect(calls).toEqual([]);
  });

  it("returns only a fixed status and the authored id it was given", async () => {
    const help = await payload("opensesame_help", { topic: "help.lock" });
    expect(Object.keys(help).sort()).toEqual(["status", "topic"]);

    const guide = await payload("opensesame_guide_start", {
      goal: "vault.lock",
    });
    expect(Object.keys(guide).sort()).toEqual(["goal", "status"]);

    for (const value of [...Object.values(help), ...Object.values(guide)]) {
      if (value === null) continue;
      expect(
        AUTHORED_STRINGS.has(String(value)),
        `guidance payload carries un-authored value ${String(value)}`,
      ).toBe(true);
    }
  });
});
