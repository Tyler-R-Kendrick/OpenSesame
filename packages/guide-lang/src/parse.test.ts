import { describe, expect, it } from "vitest";

import { GUIDE_LANG_HEADER, GUIDE_LIMITS } from "./ast.js";
import {
  GUIDE_PARSE_ERROR_CODES,
  type GuideParseErrorCode,
  guideParseErrorMessage,
} from "./errors.js";
import { type GuideParseResult, parseGuide } from "./parse.js";

const GOAL_LINE = 'goal "connection.create"';

function source(...lines: readonly string[]): string {
  return [GUIDE_LANG_HEADER, GOAL_LINE, ...lines].join("\n");
}

function codesOf(result: GuideParseResult): readonly GuideParseErrorCode[] {
  return result.ok ? [] : result.errors.map((error) => error.code);
}

function expectRejected(text: string, code: GuideParseErrorCode): void {
  const result = parseGuide(text);
  expect(result.ok).toBe(false);
  expect(codesOf(result)).toContain(code);
  expect(Object.hasOwn(result, "program")).toBe(false);
}

describe("parseGuide structure", () => {
  it("parses the header, the goal and an adaptive trajectory", () => {
    const result = parseGuide(
      source(
        'say "Connections is where a provider connection is added."',
        'focus "nav.connections" "Open Connections to begin." side=right',
        'wait target "nav.connections" event=activate timeout=30000',
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.program.version).toBe(1);
    expect(result.program.goal).toBe("connection.create");
    expect(result.program.instructions).toEqual([
      {
        kind: "say",
        message: "Connections is where a provider connection is added.",
      },
      {
        kind: "focus",
        target: "nav.connections",
        message: "Open Connections to begin.",
        side: "right",
      },
      {
        kind: "wait",
        subject: "target",
        target: "nav.connections",
        event: "activate",
        timeoutMs: 30000,
      },
    ]);
  });

  it("keeps the goal out of the instruction list", () => {
    const result = parseGuide(source("pause"));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.program.instructions).toEqual([{ kind: "pause" }]);
  });

  it("ignores blank lines and tolerates CRLF endings", () => {
    const result = parseGuide(
      `${GUIDE_LANG_HEADER}\r\n\r\n${GOAL_LINE}\r\n\r\nsay "hello"\r\n`,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.program.instructions).toEqual([
      { kind: "say", message: "hello" },
    ]);
  });

  it("accepts every wait subject", () => {
    const result = parseGuide(
      source(
        'wait target "nav.connections" event=appear timeout=250',
        'wait route "/connections" timeout=60000',
        'wait state "vault.unlocked" is=false timeout=1000',
      ),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.program.instructions).toEqual([
      {
        kind: "wait",
        subject: "target",
        target: "nav.connections",
        event: "appear",
        timeoutMs: 250,
      },
      {
        kind: "wait",
        subject: "route",
        route: "/connections",
        timeoutMs: 60000,
      },
      {
        kind: "wait",
        subject: "state",
        predicate: "vault.unlocked",
        expected: false,
        timeoutMs: 1000,
      },
    ]);
  });

  it("accepts the budgets at their limits", () => {
    const atLimit = parseGuide(
      source(
        ...Array.from(
          { length: GUIDE_LIMITS.maxInstructions },
          () => 'say "x"',
        ),
      ),
    );
    expect(atLimit.ok).toBe(true);

    const longest = parseGuide(
      source(`say "${"a".repeat(GUIDE_LIMITS.maxMessageChars)}"`),
    );
    expect(longest.ok).toBe(true);

    const blanks = Array.from({ length: GUIDE_LIMITS.maxLines - 3 }, () => "");
    const fullHeight = parseGuide(source(...blanks, "end"));
    expect(fullHeight.ok).toBe(true);
  });
});

describe("parseGuide diagnostics", () => {
  const reachable: readonly {
    readonly code: GuideParseErrorCode;
    readonly text: string;
  }[] = [
    { code: "empty_program", text: "\n   \n" },
    { code: "missing_version_header", text: `${GOAL_LINE}\nsay "hi"` },
    { code: "unsupported_version", text: `guide/2\n${GOAL_LINE}` },
    { code: "duplicate_version_header", text: source(GUIDE_LANG_HEADER) },
    { code: "missing_goal", text: `${GUIDE_LANG_HEADER}\nsay "hi"` },
    { code: "duplicate_goal", text: source('goal "connection.delete"') },
    {
      code: "goal_not_first",
      text: `${GUIDE_LANG_HEADER}\nsay "hi"\n${GOAL_LINE}`,
    },
    { code: "unknown_instruction", text: source('click "#login"') },
    { code: "malformed_arguments", text: source('focus "nav.connections"') },
    {
      code: "unknown_named_argument",
      text: source('focus "nav.connections" "m" event=activate'),
    },
    {
      code: "duplicate_named_argument",
      text: source('focus "nav.connections" "m" side=top side=left'),
    },
    { code: "unterminated_string", text: source('say "abc') },
    { code: "invalid_string_escape", text: source('say "a\\qb"') },
    { code: "invalid_identifier", text: source('focus "#button-13" "x"') },
    { code: "invalid_route", text: source('navigate "javascript:alert(1)"') },
    {
      code: "invalid_side",
      text: source('focus "nav.connections" "m" side=up'),
    },
    {
      code: "invalid_wait_subject",
      text: source('wait thing "nav.connections" timeout=1000'),
    },
    {
      code: "invalid_wait_event",
      text: source('wait target "nav.connections" event=click timeout=1000'),
    },
    {
      code: "invalid_boolean",
      text: source('wait state "vault.unlocked" is=yes timeout=1000'),
    },
    {
      code: "timeout_not_an_integer",
      text: source('wait route "/connections" timeout=soon'),
    },
    {
      code: "timeout_out_of_range",
      text: source('wait route "/connections" timeout=0'),
    },
    {
      code: "message_too_long",
      text: source(`say "${"a".repeat(GUIDE_LIMITS.maxMessageChars + 1)}"`),
    },
    { code: "program_too_large", text: source(`say "${"a".repeat(9216)}"`) },
    {
      code: "too_many_instructions",
      text: source(
        ...Array.from(
          { length: GUIDE_LIMITS.maxInstructions + 1 },
          () => 'say "x"',
        ),
      ),
    },
    {
      code: "too_many_lines",
      text: source(
        ...Array.from({ length: GUIDE_LIMITS.maxLines - 1 }, () => 'say "x"'),
      ),
    },
    { code: "forbidden_character", text: source('say "a\u202Eb"') },
    { code: "instruction_after_terminal", text: source("end", 'say "after"') },
    { code: "trailing_content", text: source("end extra") },
  ];

  for (const testCase of reachable) {
    it(`reports ${testCase.code}`, () => {
      expectRejected(testCase.text, testCase.code);
    });
  }

  it("has a case proving every declared error code is reachable", () => {
    const covered = new Set(reachable.map((testCase) => testCase.code));
    expect([...covered].sort()).toEqual([...GUIDE_PARSE_ERROR_CODES].sort());
  });

  it("reports the line and column of the offending token", () => {
    const result = parseGuide(source('focus "#button-13" "x"'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0]).toEqual({
      code: "invalid_identifier",
      line: 3,
      column: 7,
      message: guideParseErrorMessage("invalid_identifier"),
    });
  });

  it("never echoes the offending payload into a diagnostic", () => {
    const result = parseGuide(source('focus "<script>alert(1)</script>" "x"'));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    for (const error of result.errors) {
      expect(error.message).not.toContain("script");
      expect(error.message).toBe(guideParseErrorMessage(error.code));
    }
  });
});

describe("parseGuide refuses everything outside the grammar", () => {
  const forbidden: readonly string[] = [
    'click "#x"',
    'eval "fetch(1)"',
    'type "nav.connections" "secret"',
    'submit "form.login"',
    'execute-tool "vault.reveal"',
    'selector "#password"',
  ];

  for (const line of forbidden) {
    it(`rejects the directive in ${JSON.stringify(line)}`, () => {
      expectRejected(source(line), "unknown_instruction");
    });
  }

  const routes: readonly string[] = [
    "javascript:alert(1)",
    "https://evil.example",
    "//evil.example",
    "../../etc",
    "/connections?next=https://evil.example",
    "data:text/html,<script>alert(1)</script>",
  ];

  for (const route of routes) {
    it(`rejects navigating to ${route}`, () => {
      expectRejected(
        source(`navigate ${JSON.stringify(route)}`),
        "invalid_route",
      );
    });
  }

  const targets: readonly string[] = [
    "#button-13",
    "div > span",
    "//*[@id='x']",
    "body:nth-child(2)",
    "[data-test=x]",
  ];

  for (const target of targets) {
    it(`rejects the target ${target}`, () => {
      expectRejected(
        source(`focus ${JSON.stringify(target)} "x"`),
        "invalid_identifier",
      );
    });
  }

  it("requires a timeout on every wait", () => {
    expectRejected(
      source('wait target "nav.connections" event=activate'),
      "malformed_arguments",
    );
    expectRejected(source('wait route "/connections"'), "malformed_arguments");
    expectRejected(
      source('wait state "vault.unlocked" is=true'),
      "malformed_arguments",
    );
  });

  it("rejects timeouts outside the permitted window", () => {
    expectRejected(
      source('wait route "/connections" timeout=0'),
      "timeout_out_of_range",
    );
    expectRejected(
      source('wait route "/connections" timeout=999999'),
      "timeout_out_of_range",
    );
    expectRejected(
      source(
        `wait route "/connections" timeout=${GUIDE_LIMITS.minTimeoutMs - 1}`,
      ),
      "timeout_out_of_range",
    );
    expectRejected(
      source(
        `wait route "/connections" timeout=${GUIDE_LIMITS.maxTimeoutMs + 1}`,
      ),
      "timeout_out_of_range",
    );
  });

  it("rejects a program that outgrows any budget", () => {
    expectRejected(
      source(...Array.from({ length: 9 }, () => 'say "x"')),
      "too_many_instructions",
    );
    expectRejected(source(`say "${"a".repeat(501)}"`), "message_too_long");
    expectRejected(source(`say "${"a".repeat(9216)}"`), "program_too_large");
    expectRejected(
      source(...Array.from({ length: 31 }, () => 'say "x"')),
      "too_many_lines",
    );
  });

  it("rejects a repeated header, a repeated goal and a displaced goal", () => {
    expectRejected(source(GUIDE_LANG_HEADER), "duplicate_version_header");
    expectRejected(source('goal "connection.delete"'), "duplicate_goal");
    expectRejected(
      `${GUIDE_LANG_HEADER}\nsay "hi"\n${GOAL_LINE}`,
      "goal_not_first",
    );
  });

  it("rejects anything after a terminal instruction", () => {
    expectRejected(source("end", 'say "after"'), "instruction_after_terminal");
    expectRejected(source("pause", "end"), "instruction_after_terminal");
  });
});

describe("parseGuide never yields a runnable prefix", () => {
  it("returns no program when a later line is not in the grammar", () => {
    const text = source(
      'say "Connections is where a provider connection is added."',
      'focus "nav.connections" "Open Connections." side=right',
      'click "#x"',
    );
    const result = parseGuide(text);
    expect(result.ok).toBe(false);
    expect(Object.hasOwn(result, "program")).toBe(false);
    expect(codesOf(result)).toEqual(["unknown_instruction"]);
  });

  it("returns no program when the valid prefix is long and the tail is not", () => {
    const result = parseGuide(
      source(
        'say "one"',
        'say "two"',
        'say "three"',
        'navigate "javascript:alert(1)"',
        "end",
      ),
    );
    expect(result.ok).toBe(false);
    expect(Object.hasOwn(result, "program")).toBe(false);
  });
});

describe("parseGuide text handling", () => {
  it("round-trips astral-plane text in a message", () => {
    const message = "Open the 🚀 panel, then the 𝄞 tab";
    const result = parseGuide(source(`say ${JSON.stringify(message)}`));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.program.instructions).toEqual([{ kind: "say", message }]);
  });

  it("accepts an escaped astral code point as a surrogate pair", () => {
    const result = parseGuide(source('say "\\ud83d\\ude80"'));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.program.instructions).toEqual([
      { kind: "say", message: "🚀" },
    ]);
  });

  it("rejects a raw lone surrogate", () => {
    expectRejected(source('say "a\ud800b"'), "forbidden_character");
    expectRejected(source('say "a\udc00b"'), "forbidden_character");
  });

  it("rejects an escaped lone surrogate", () => {
    expectRejected(source('say "a\\ud800b"'), "invalid_string_escape");
    expectRejected(source('say "a\\udc00b"'), "invalid_string_escape");
    expectRejected(source('say "\\ud800\\ud800"'), "invalid_string_escape");
  });

  it("rejects a bidi override in a message", () => {
    expectRejected(source('say "click \u202Ehere"'), "forbidden_character");
    expectRejected(source('say "click \\u202ehere"'), "forbidden_character");
  });

  it("rejects a zero-width space in a message", () => {
    expectRejected(source('say "va\u200Bult"'), "forbidden_character");
    expectRejected(source('say "va\\u200bult"'), "forbidden_character");
  });

  it("rejects a NUL in a message", () => {
    expectRejected(source('say "a\\u0000b"'), "forbidden_character");
  });

  it("counts message length in code points, not UTF-16 units", () => {
    const emoji = "🚀".repeat(GUIDE_LIMITS.maxMessageChars);
    const result = parseGuide(source(`say ${JSON.stringify(emoji)}`));
    expect(result.ok).toBe(true);
    expectRejected(
      source(`say ${JSON.stringify(`${emoji}🚀`)}`),
      "message_too_long",
    );
  });
});

describe("parseGuide treats markup as prose", () => {
  const payloads: readonly string[] = [
    "<img src=x onerror=alert(1)>",
    "<script>alert(1)</script>",
    "javascript:alert(1)",
    "${constructor.constructor('alert(1)')()}",
    "</div><iframe src=//evil.example>",
  ];

  for (const payload of payloads) {
    it(`keeps ${payload} as inert text in a say`, () => {
      const result = parseGuide(source(`say ${JSON.stringify(payload)}`));
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.program.instructions).toEqual([
        { kind: "say", message: payload },
      ]);
    });

    it(`keeps ${payload} as inert text in a focus message`, () => {
      const result = parseGuide(
        source(`focus "nav.connections" ${JSON.stringify(payload)}`),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.program.instructions).toEqual([
        {
          kind: "focus",
          target: "nav.connections",
          message: payload,
          side: null,
        },
      ]);
    });
  }

  it("never lets markup in a message become a directive", () => {
    const result = parseGuide(
      source('say "<script>navigate \\"https://evil.example\\"</script>"'),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.program.instructions.length).toBe(1);
    const [instruction] = result.program.instructions;
    expect(instruction?.kind).toBe("say");
  });
});
