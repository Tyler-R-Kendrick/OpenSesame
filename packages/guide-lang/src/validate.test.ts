import { describe, expect, it } from "vitest";

import { GUIDE_LANG_HEADER, type GuideProgram } from "./ast.js";
import {
  GUIDE_GOAL_INDEX,
  type GuideVocabulary,
  compileGuide,
  validateGuide,
} from "./validate.js";

const vocabulary: GuideVocabulary = {
  goals: ["connection.create"],
  targets: ["nav.connections", "connection.add"],
  routes: ["/connections"],
  predicates: ["vault.unlocked"],
};

function programOf(...lines: readonly string[]): string {
  return [GUIDE_LANG_HEADER, 'goal "connection.create"', ...lines].join("\n");
}

const known: GuideProgram = {
  version: 1,
  goal: "connection.create",
  instructions: [
    { kind: "navigate", route: "/connections" },
    { kind: "scroll", target: "nav.connections" },
    {
      kind: "focus",
      target: "connection.add",
      message: "Add a connection here.",
      side: "right",
    },
    { kind: "wait", subject: "route", route: "/connections", timeoutMs: 5000 },
    {
      kind: "wait",
      subject: "state",
      predicate: "vault.unlocked",
      expected: true,
      timeoutMs: 5000,
    },
    { kind: "end" },
  ],
};

describe("validateGuide", () => {
  it("accepts a program whose every identifier is registered", () => {
    expect(validateGuide(known, vocabulary)).toEqual({ ok: true });
  });

  it("rejects an unregistered goal", () => {
    const result = validateGuide(
      { version: 1, goal: "connection.destroy", instructions: [] },
      vocabulary,
    );
    expect(result).toEqual({
      ok: false,
      errors: [
        {
          code: "unknown_goal",
          index: GUIDE_GOAL_INDEX,
          id: "connection.destroy",
        },
      ],
    });
  });

  it("rejects an unregistered target, in a popover and in a wait", () => {
    const result = validateGuide(
      {
        version: 1,
        goal: "connection.create",
        instructions: [
          { kind: "hint", target: "nav.secrets", message: "x", side: null },
          {
            kind: "wait",
            subject: "target",
            target: "nav.secrets",
            event: "activate",
            timeoutMs: 1000,
          },
        ],
      },
      vocabulary,
    );
    expect(result).toEqual({
      ok: false,
      errors: [
        { code: "unknown_target", index: 0, id: "nav.secrets" },
        { code: "unknown_target", index: 1, id: "nav.secrets" },
      ],
    });
  });

  it("rejects an unregistered route", () => {
    const result = validateGuide(
      {
        version: 1,
        goal: "connection.create",
        instructions: [
          { kind: "navigate", route: "/admin" },
          { kind: "wait", subject: "route", route: "/admin", timeoutMs: 1000 },
        ],
      },
      vocabulary,
    );
    expect(result).toEqual({
      ok: false,
      errors: [
        { code: "unknown_route", index: 0, id: "/admin" },
        { code: "unknown_route", index: 1, id: "/admin" },
      ],
    });
  });

  it("rejects an unregistered predicate", () => {
    const result = validateGuide(
      {
        version: 1,
        goal: "connection.create",
        instructions: [
          {
            kind: "wait",
            subject: "state",
            predicate: "vault.locked",
            expected: false,
            timeoutMs: 1000,
          },
        ],
      },
      vocabulary,
    );
    expect(result).toEqual({
      ok: false,
      errors: [{ code: "unknown_predicate", index: 0, id: "vault.locked" }],
    });
  });
});

describe("compileGuide", () => {
  it("returns the program when the source parses and every identifier is known", () => {
    const result = compileGuide(
      programOf(
        'navigate "/connections"',
        'focus "connection.add" "Add a connection here." side=right',
        'wait target "connection.add" event=activate timeout=30000',
      ),
      vocabulary,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.program.instructions.length).toBe(3);
  });

  it("stops at the parse stage and yields no program", () => {
    const result = compileGuide(programOf('click "#x"'), vocabulary);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("parse");
    expect(Object.hasOwn(result, "program")).toBe(false);
  });

  it("stops at the validate stage and yields no program", () => {
    const result = compileGuide(
      programOf('focus "nav.secrets" "Here." side=top'),
      vocabulary,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("validate");
    expect(result.errors).toEqual([
      { code: "unknown_target", index: 0, id: "nav.secrets" },
    ]);
    expect(Object.hasOwn(result, "program")).toBe(false);
  });

  it("reports a syntactically valid but unregistered route as a validation failure", () => {
    const result = compileGuide(
      programOf('navigate "/admin/secrets"'),
      vocabulary,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("validate");
  });

  it("reports an unusable route as a parse failure, before the vocabulary is consulted", () => {
    const result = compileGuide(
      programOf('navigate "https://evil.example"'),
      vocabulary,
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.stage).toBe("parse");
  });
});
