import fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  GUIDE_LANG_HEADER,
  GUIDE_LIMITS,
  type GuideInstruction,
  type GuideProgram,
  hasForbiddenTextCharacter,
} from "./ast.js";
import {
  isGuideGoalId,
  isGuidePredicateId,
  isGuideRouteId,
  isGuideTargetId,
} from "./ids.js";
import { parseGuide } from "./parse.js";
import { serializeGuide } from "./serialize.js";

const GOAL_LINE = 'goal "connection.create"';

function containsLoneSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : 0;
      if (next < 0xdc00 || next > 0xdfff) return true;
      index += 1;
      continue;
    }
    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }
  return false;
}

/** Printable ASCII plus the pieces that exercise escaping, astral text and markup. */
const messageText = fc
  .oneof(
    fc.string({ maxLength: 40 }),
    fc
      .array(
        fc.constantFrom(
          "a",
          " ",
          ".",
          '"',
          "\\",
          "/",
          "\n",
          "\t",
          "🚀",
          "𝄞",
          "é",
          "<script>alert(1)</script>",
        ),
        { maxLength: 12 },
      )
      .map((parts) => parts.join("")),
  )
  .filter(
    (text) =>
      !hasForbiddenTextCharacter(text) &&
      !containsLoneSurrogate(text) &&
      Array.from(text).length <= GUIDE_LIMITS.maxMessageChars,
  );

const targetId = fc.constantFrom(
  "nav.connections",
  "connection.add",
  "a",
  "a-b.c-d",
);
const routeId = fc.constantFrom("/", "/connections", "/settings/security");
const predicateId = fc.constantFrom("vault.unlocked", "connection.pending");
const side = fc.constantFrom("top", "right", "bottom", "left", null);
const timeoutMs = fc.integer({
  min: GUIDE_LIMITS.minTimeoutMs,
  max: GUIDE_LIMITS.maxTimeoutMs,
});

const popoverKind = fc.constantFrom("focus", "hint", "annotate");

const nonTerminalInstruction: fc.Arbitrary<GuideInstruction> = fc.oneof(
  messageText.map((message): GuideInstruction => ({ kind: "say", message })),
  messageText.map(
    (message): GuideInstruction => ({ kind: "success", message }),
  ),
  fc
    .tuple(popoverKind, targetId, messageText, side)
    .map(([kind, target, message, placement]): GuideInstruction => {
      if (kind === "focus") return { kind, target, message, side: placement };
      if (kind === "hint") return { kind, target, message, side: placement };
      return { kind: "annotate", target, message, side: placement };
    }),
  targetId.map((target): GuideInstruction => ({ kind: "scroll", target })),
  routeId.map((route): GuideInstruction => ({ kind: "navigate", route })),
  fc
    .tuple(
      targetId,
      fc.constantFrom("activate", "appear", "disappear"),
      timeoutMs,
    )
    .map(
      ([target, event, timeout]): GuideInstruction => ({
        kind: "wait",
        subject: "target",
        target,
        event,
        timeoutMs: timeout,
      }),
    ),
  fc.tuple(routeId, timeoutMs).map(
    ([route, timeout]): GuideInstruction => ({
      kind: "wait",
      subject: "route",
      route,
      timeoutMs: timeout,
    }),
  ),
  fc.tuple(predicateId, fc.boolean(), timeoutMs).map(
    ([predicate, expected, timeout]): GuideInstruction => ({
      kind: "wait",
      subject: "state",
      predicate,
      expected,
      timeoutMs: timeout,
    }),
  ),
);

const terminalInstruction: fc.Arbitrary<GuideInstruction> = fc.constantFrom(
  { kind: "pause" },
  { kind: "end" },
);

const programArbitrary: fc.Arbitrary<GuideProgram> = fc
  .tuple(
    fc.constantFrom("connection.create", "vault.unlock", "a"),
    fc.array(nonTerminalInstruction, {
      maxLength: GUIDE_LIMITS.maxInstructions - 1,
    }),
    fc.option(terminalInstruction, { nil: null }),
  )
  .map(
    ([goal, body, tail]): GuideProgram => ({
      version: 1,
      goal,
      instructions: tail === null ? body : [...body, tail],
    }),
  );

/**
 * Text drawn from the alphabet an attacker would actually reach for, escaped
 * into a single quoted token. The identifier-like arm matters: without it the
 * parser would reject every sample and the properties below would hold
 * vacuously, so each one also counts the samples it did accept.
 */
const identifierLike = fc
  .array(
    fc.constantFrom(
      "a",
      "b",
      "z",
      "0",
      "9",
      ".",
      "-",
      "_",
      "/",
      "#",
      ">",
      ":",
      " ",
      "A",
    ),
    { minLength: 1, maxLength: 12 },
  )
  .map((parts) => parts.join(""));

const quotedToken = fc
  .oneof(
    fc.string({ unit: "binary", maxLength: 60 }),
    fc.string({ maxLength: 40 }),
    identifierLike,
    identifierLike.map((text) => `/${text}`),
  )
  .map((text) => JSON.stringify(text));

describe("parseGuide over arbitrary input", () => {
  it("never throws and never accepts text that does not start with the header", () => {
    fc.assert(
      fc.property(fc.string({ unit: "binary", maxLength: 240 }), (text) => {
        const result = parseGuide(text);
        if (result.ok) {
          expect(text.trimStart().startsWith(GUIDE_LANG_HEADER)).toBe(true);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("never throws on text shaped like a program", () => {
    fc.assert(
      fc.property(
        fc.array(fc.string({ unit: "binary", maxLength: 40 }), {
          maxLength: 8,
        }),
        (lines) => {
          const text = [GUIDE_LANG_HEADER, GOAL_LINE, ...lines].join("\n");
          expect(() => parseGuide(text)).not.toThrow();
        },
      ),
      { numRuns: 500 },
    );
  });
});

describe("serializeGuide round-trip", () => {
  it("parses back to the program it was written from", () => {
    fc.assert(
      fc.property(programArbitrary, (program) => {
        const result = parseGuide(serializeGuide(program));
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(result.program).toEqual(program);
      }),
      { numRuns: 500 },
    );
  });

  it("is stable: serializing a reparsed program reproduces the text", () => {
    fc.assert(
      fc.property(programArbitrary, (program) => {
        const text = serializeGuide(program);
        const result = parseGuide(text);
        expect(result.ok).toBe(true);
        if (!result.ok) return;
        expect(serializeGuide(result.program)).toBe(text);
      }),
      { numRuns: 500 },
    );
  });
});

describe("no arbitrary string becomes an identifier", () => {
  it("never produces a target the id validator rejects", () => {
    let accepted = 0;
    fc.assert(
      fc.property(quotedToken, (token) => {
        const result = parseGuide(
          [GUIDE_LANG_HEADER, GOAL_LINE, `focus ${token} "message"`].join("\n"),
        );
        if (!result.ok) return;
        const [instruction] = result.program.instructions;
        expect(instruction?.kind).toBe("focus");
        if (instruction === undefined || instruction.kind !== "focus") return;
        expect(isGuideTargetId(instruction.target)).toBe(true);
        accepted += 1;
      }),
      { numRuns: 1000 },
    );
    expect(accepted).toBeGreaterThan(0);
  });

  it("never produces a route the route validator rejects", () => {
    let accepted = 0;
    fc.assert(
      fc.property(quotedToken, (token) => {
        const result = parseGuide(
          [GUIDE_LANG_HEADER, GOAL_LINE, `navigate ${token}`].join("\n"),
        );
        if (!result.ok) return;
        const [instruction] = result.program.instructions;
        if (instruction === undefined || instruction.kind !== "navigate") {
          expect.unreachable("navigate parsed as another directive");
          return;
        }
        expect(isGuideRouteId(instruction.route)).toBe(true);
        expect(instruction.route.startsWith("/")).toBe(true);
        expect(instruction.route.startsWith("//")).toBe(false);
        expect(instruction.route.includes("..")).toBe(false);
        accepted += 1;
      }),
      { numRuns: 1000 },
    );
    expect(accepted).toBeGreaterThan(0);
  });

  it("never produces a predicate the id validator rejects", () => {
    let accepted = 0;
    fc.assert(
      fc.property(quotedToken, (token) => {
        const result = parseGuide(
          [
            GUIDE_LANG_HEADER,
            GOAL_LINE,
            `wait state ${token} is=true timeout=1000`,
          ].join("\n"),
        );
        if (!result.ok) return;
        const [instruction] = result.program.instructions;
        if (
          instruction === undefined ||
          instruction.kind !== "wait" ||
          instruction.subject !== "state"
        ) {
          expect.unreachable("wait state parsed as another directive");
          return;
        }
        expect(isGuidePredicateId(instruction.predicate)).toBe(true);
        accepted += 1;
      }),
      { numRuns: 1000 },
    );
    expect(accepted).toBeGreaterThan(0);
  });

  it("never produces a goal the id validator rejects", () => {
    let accepted = 0;
    fc.assert(
      fc.property(quotedToken, (token) => {
        const result = parseGuide(
          [GUIDE_LANG_HEADER, `goal ${token}`].join("\n"),
        );
        if (!result.ok) return;
        expect(isGuideGoalId(result.program.goal)).toBe(true);
        accepted += 1;
      }),
      { numRuns: 1000 },
    );
    expect(accepted).toBeGreaterThan(0);
  });

  it("never produces a message carrying a forbidden character", () => {
    let accepted = 0;
    fc.assert(
      fc.property(quotedToken, (token) => {
        const result = parseGuide(
          [GUIDE_LANG_HEADER, GOAL_LINE, `say ${token}`].join("\n"),
        );
        if (!result.ok) return;
        const [instruction] = result.program.instructions;
        if (instruction === undefined || instruction.kind !== "say") {
          expect.unreachable("say parsed as another directive");
          return;
        }
        expect(hasForbiddenTextCharacter(instruction.message)).toBe(false);
        expect(containsLoneSurrogate(instruction.message)).toBe(false);
        expect(Array.from(instruction.message).length).toBeLessThanOrEqual(
          GUIDE_LIMITS.maxMessageChars,
        );
        accepted += 1;
      }),
      { numRuns: 1000 },
    );
    expect(accepted).toBeGreaterThan(0);
  });
});
