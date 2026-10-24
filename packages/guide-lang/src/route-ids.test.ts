import { describe, expect, it } from "vitest";
import { GUIDE_LANG_HEADER } from "./ast.js";
import { MAX_ROUTE_ID_CHARS, isGuideRouteId } from "./ids.js";
import { compileGuide } from "./validate.js";

const AI_ROUTE = "/settings/features/ai/support.local-ai";
const vocabulary = {
  goals: ["settings.ai"],
  targets: [],
  routes: [AI_ROUTE],
  predicates: [],
};

function trajectory(route: string): string {
  return [
    GUIDE_LANG_HEADER,
    'goal "settings.ai"',
    `navigate ${JSON.stringify(route)}`,
    `wait route ${JSON.stringify(route)} timeout=1000`,
  ].join("\n");
}

describe("dotted guide route namespaces", () => {
  it("compiles navigation and a wait for the registered local AI settings page", () => {
    expect(compileGuide(trajectory(AI_ROUTE), vocabulary)).toEqual({
      ok: true,
      program: {
        version: 1,
        goal: "settings.ai",
        instructions: [
          { kind: "navigate", route: AI_ROUTE },
          { kind: "wait", subject: "route", route: AI_ROUTE, timeoutMs: 1000 },
        ],
      },
    });
  });

  it("preserves root, nested and hyphenated paths alongside dotted segments", () => {
    for (const route of [
      "/",
      "/connections",
      "/settings/item-types",
      AI_ROUTE,
      "/settings/model-family.v2/local-ai.provider-1",
    ]) {
      expect(isGuideRouteId(route), route).toBe(true);
    }
  });

  it("keeps the 64-character limit for dotted paths", () => {
    expect(MAX_ROUTE_ID_CHARS).toBe(64);
    const route = `/${"a".repeat(MAX_ROUTE_ID_CHARS - 3)}.a`;
    expect(route.length).toBe(MAX_ROUTE_ID_CHARS);
    expect(isGuideRouteId(route)).toBe(true);
    expect(isGuideRouteId(`${route}a`)).toBe(false);
  });

  it.each([
    "/settings/features/ai/support.remote-ai",
    `${AI_ROUTE}/details`,
    `${AI_ROUTE}-other`,
    "/settings/features/ai",
  ])(
    "requires exact live membership for %s in navigation and waits",
    (route) => {
      expect(isGuideRouteId(route)).toBe(true);
      expect(compileGuide(trajectory(route), vocabulary)).toEqual({
        ok: false,
        stage: "validate",
        errors: [
          { code: "unknown_route", index: 0, id: route },
          { code: "unknown_route", index: 1, id: route },
        ],
      });
    },
  );
});

const malformedRoutes = [
  "",
  "settings/features/ai/support.local-ai",
  "javascript:alert(1)",
  "data:text/html,<script>alert(1)</script>",
  "https://evil.example/settings",
  "http://evil.example",
  "//evil.example",
  "///settings",
  "/settings//ai",
  "/settings/",
  ".",
  "..",
  "../../etc",
  "/./settings",
  "/settings/../vault",
  "/settings/support..local-ai",
  "/settings/.support",
  "/settings/support.",
  "/settings/-support",
  "/settings/support-",
  "/settings/support.-local-ai",
  "/settings/support-.local-ai",
  "/settings/support--local-ai",
  "/settings/Support.local-ai",
  "/settings/support_local-ai",
  "/settings/support:local-ai",
  "/settings/support.local-ai?next=https://evil.example",
  "/settings/support.local-ai#control",
  "/settings/support.local-ai;next=vault",
  "/settings/support%2flocal-ai",
  "/settings/support%2Flocal-ai",
  "/settings/support%5clocal-ai",
  "/settings/%2e%2e/vault",
  "/settings/support%252flocal-ai",
  "/settings/support%2elocal-ai",
  "/settings/support\\local-ai",
  "/settings/support local-ai",
  "/settings/支持.local-ai",
  '/settings/[data-secret="x"]',
  "/settings/*",
  "/settings/support.local-ai>vault",
  "/settings/support\nlocal-ai",
  "/settings/support\u0000local-ai",
  `/${"a".repeat(MAX_ROUTE_ID_CHARS)}`,
];

describe("guide route refusals", () => {
  it.each(malformedRoutes)(
    "refuses %j before consulting even a matching vocabulary",
    (route) => {
      expect(isGuideRouteId(route)).toBe(false);
      for (const line of [
        `navigate ${JSON.stringify(route)}`,
        `wait route ${JSON.stringify(route)} timeout=1000`,
      ]) {
        const source = [GUIDE_LANG_HEADER, 'goal "settings.ai"', line].join(
          "\n",
        );
        const result = compileGuide(source, { ...vocabulary, routes: [route] });
        expect(result.ok).toBe(false);
        if (result.ok) continue;
        expect(result.stage).toBe("parse");
        expect(Object.hasOwn(result, "program")).toBe(false);
      }
    },
  );
});
