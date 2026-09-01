import { describe, expect, it } from "vitest";

import {
  GUIDE_SIDES,
  type GuideInstruction,
  type GuideProgram,
  type GuideSide,
} from "./ast.js";
import { parseGuide } from "./parse.js";
import { serializeGuide, serializeInstruction } from "./serialize.js";

function programOf(...instructions: readonly GuideInstruction[]): GuideProgram {
  return { version: 1, goal: "connection.create", instructions };
}

function popover(side: GuideSide | null): GuideInstruction {
  return {
    kind: "focus",
    target: "nav.connections",
    message: "Open Connections to begin.",
    side,
  };
}

const forms: readonly GuideInstruction[] = [
  {
    kind: "say",
    message: "Connections is where a provider connection is added.",
  },
  { kind: "success", message: "The connection is live." },
  popover(null),
  ...GUIDE_SIDES.map(popover),
  { kind: "hint", target: "nav.connections", message: "Here.", side: null },
  { kind: "hint", target: "nav.connections", message: "Here.", side: "bottom" },
  { kind: "annotate", target: "nav.connections", message: "Here.", side: null },
  {
    kind: "annotate",
    target: "nav.connections",
    message: "Here.",
    side: "left",
  },
  { kind: "scroll", target: "nav.connections" },
  { kind: "navigate", route: "/connections" },
  {
    kind: "wait",
    subject: "target",
    target: "nav.connections",
    event: "activate",
    timeoutMs: 30000,
  },
  {
    kind: "wait",
    subject: "target",
    target: "nav.connections",
    event: "appear",
    timeoutMs: 250,
  },
  {
    kind: "wait",
    subject: "target",
    target: "nav.connections",
    event: "disappear",
    timeoutMs: 60000,
  },
  { kind: "wait", subject: "route", route: "/connections", timeoutMs: 5000 },
  {
    kind: "wait",
    subject: "state",
    predicate: "vault.unlocked",
    expected: true,
    timeoutMs: 5000,
  },
  {
    kind: "wait",
    subject: "state",
    predicate: "vault.unlocked",
    expected: false,
    timeoutMs: 5000,
  },
  { kind: "pause" },
  { kind: "end" },
];

describe("serializeGuide round-trips", () => {
  for (const instruction of forms) {
    it(`round-trips ${serializeInstruction(instruction)}`, () => {
      const original = programOf(instruction);
      const result = parseGuide(serializeGuide(original));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.program).toEqual(original);
    });
  }

  it("round-trips a whole trajectory", () => {
    const original = programOf(
      { kind: "say", message: "Connections holds every provider connection." },
      { kind: "navigate", route: "/connections" },
      {
        kind: "wait",
        subject: "route",
        route: "/connections",
        timeoutMs: 10000,
      },
      popover("right"),
      {
        kind: "wait",
        subject: "target",
        target: "nav.connections",
        event: "activate",
        timeoutMs: 30000,
      },
      { kind: "success", message: "Done." },
      { kind: "end" },
    );
    const result = parseGuide(serializeGuide(original));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.program).toEqual(original);
  });

  it("round-trips text that needs escaping", () => {
    const message = 'She said "go" \\ then\nstopped\there';
    const original = programOf({ kind: "say", message });
    const text = serializeGuide(original);
    expect(text.split("\n").length).toBe(4);
    const result = parseGuide(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.program).toEqual(original);
  });

  it("emits astral-plane text literally", () => {
    const original = programOf({ kind: "say", message: "Open 🚀 then 𝄞" });
    const text = serializeGuide(original);
    expect(text).toContain("🚀");
    expect(text).not.toContain("\\u");
    const result = parseGuide(text);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.program).toEqual(original);
  });
});

describe("serializeGuide is canonical", () => {
  it("writes the header, the goal and then the instructions", () => {
    expect(serializeGuide(programOf(popover("right"), { kind: "end" }))).toBe(
      [
        "guide/1",
        'goal "connection.create"',
        'focus "nav.connections" "Open Connections to begin." side=right',
        "end",
        "",
      ].join("\n"),
    );
  });

  it("orders named arguments the same way every time", () => {
    expect(
      serializeInstruction({
        kind: "wait",
        subject: "target",
        target: "nav.connections",
        event: "activate",
        timeoutMs: 30000,
      }),
    ).toBe('wait target "nav.connections" event=activate timeout=30000');
    expect(
      serializeInstruction({
        kind: "wait",
        subject: "state",
        predicate: "vault.unlocked",
        expected: true,
        timeoutMs: 1000,
      }),
    ).toBe('wait state "vault.unlocked" is=true timeout=1000');
  });

  it("is stable across repeated serialization", () => {
    const original = programOf(...forms.slice(0, 8));
    const once = serializeGuide(original);
    expect(serializeGuide(original)).toBe(once);
    const reparsed = parseGuide(once);
    expect(reparsed.ok).toBe(true);
    if (!reparsed.ok) return;
    expect(serializeGuide(reparsed.program)).toBe(once);
  });

  it("gives two equal programs built differently the same text", () => {
    const literal: GuideProgram = {
      goal: "connection.create",
      version: 1,
      instructions: [
        { message: "Open Connections.", kind: "say" },
        {
          side: null,
          kind: "hint",
          message: "Here.",
          target: "nav.connections",
        },
      ],
    };
    const assembled = programOf(sayStep("Open Connections."), popoverHint());
    expect(serializeGuide(literal)).toBe(serializeGuide(assembled));
    expect(literal).toEqual(assembled);
  });
});

function sayStep(message: string): GuideInstruction {
  return { kind: "say", message };
}

function popoverHint(): GuideInstruction {
  const target = ["nav", "connections"].join(".");
  return { kind: "hint", target, message: "Here.", side: null };
}
