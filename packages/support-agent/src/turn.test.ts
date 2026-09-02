import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  SUPPORT_LIMITS,
  type SupportAgentAvailability,
  type SupportAgentPort,
  type SupportRequest,
  type SupportTurn,
} from "./contract.js";
import { fakeAgentReplanning, fakeSupportPageContext } from "./fake.js";
import {
  type GuideCompileIssue,
  guideRepairInstruction,
  parseSupportTurn,
  runSupportTurn,
  supportVocabulary,
} from "./turn.js";

const FENCE = "```";

const VALID_GUIDE = [
  "guide/1",
  'goal "connection.create"',
  'say "Connections is where a provider connection is added."',
  'focus "nav.connections" "Open Connections to begin." side=right',
  'wait target "nav.connections" event=activate timeout=30000',
].join("\n");

const UNKNOWN_DIRECTIVE_GUIDE = [
  "guide/1",
  'goal "connection.create"',
  'click "#login"',
].join("\n");

const UNKNOWN_TARGET_GUIDE = [
  "guide/1",
  'goal "connection.create"',
  'focus "nav.billing" "Open Billing." side=right',
].join("\n");

function fenced(guide: string): string {
  return [`${FENCE}guide`, guide, FENCE].join("\n");
}

function request(): SupportRequest {
  return {
    question: "How do I add a connection?",
    history: [],
    context: fakeSupportPageContext(),
  };
}

const VOCABULARY = supportVocabulary(fakeSupportPageContext());

describe("parseSupportTurn", () => {
  it("splits prose from a fenced guide block", () => {
    const turn = parseSupportTurn(
      ["Open Connections from the sidebar.", "", fenced(VALID_GUIDE)].join(
        "\n",
      ),
    );
    expect(turn.answer).toBe("Open Connections from the sidebar.");
    expect(turn.guide).toBe(VALID_GUIDE);
  });

  it("returns a null guide for prose that has none", () => {
    const turn = parseSupportTurn(
      "Connections lives in the sidebar. Open it and press Add.",
    );
    expect(turn.guide).toBeNull();
    expect(turn.answer).toBe(
      "Connections lives in the sidebar. Open it and press Add.",
    );
  });

  it("ignores a fenced block that is not a guide", () => {
    const turn = parseSupportTurn(
      ["Here is some JSON.", `${FENCE}json`, "{}", FENCE].join("\n"),
    );
    expect(turn.guide).toBeNull();
    expect(turn.answer).toContain("Here is some JSON.");
  });

  it("accepts a bare fence whose body opens with the version header", () => {
    const turn = parseSupportTurn(
      ["Do this:", FENCE, VALID_GUIDE, FENCE].join("\n"),
    );
    expect(turn.guide).toBe(VALID_GUIDE);
    expect(turn.answer).toBe("Do this:");
  });

  it("accepts an unfenced, line-anchored program", () => {
    const turn = parseSupportTurn(["Do this:", "", VALID_GUIDE].join("\n"));
    expect(turn.guide).toBe(VALID_GUIDE);
    expect(turn.answer).toBe("Do this:");
  });

  it("never throws on garbage", () => {
    for (const raw of [
      "",
      "```",
      "```guide",
      "\u0000\u0007",
      `${FENCE}guide\n`,
    ]) {
      expect(() => parseSupportTurn(raw)).not.toThrow();
    }
    expect(parseSupportTurn("").answer).toBe("");
  });

  it("clamps the answer to maxAnswerChars", () => {
    const turn = parseSupportTurn(
      "a".repeat(SUPPORT_LIMITS.maxAnswerChars + 900),
    );
    expect(turn.answer).toHaveLength(SUPPORT_LIMITS.maxAnswerChars);
  });

  it("never throws and never over-runs the answer budget, for any string", () => {
    fc.assert(
      fc.property(fc.string({ maxLength: 4000 }), (raw) => {
        const turn = parseSupportTurn(raw);
        expect(turn.answer.length).toBeLessThanOrEqual(
          SUPPORT_LIMITS.maxAnswerChars,
        );
        expect(turn.suggestedQuestions).toEqual([]);
      }),
      { numRuns: 300 },
    );
  });

  it("mines no suggestions out of prose", () => {
    const turn = parseSupportTurn("Try asking: how do I unlock the vault?");
    expect(turn.suggestedQuestions).toEqual([]);
  });
});

describe("runSupportTurn", () => {
  it("compiles a valid program and asks once", async () => {
    const agent = fakeAgentReplanning([
      { answer: "Open Connections.", guide: fenced(VALID_GUIDE) },
    ]);
    const outcome = await runSupportTurn(agent, request(), VOCABULARY, {
      signal: new AbortController().signal,
    });
    expect(outcome.answer).toBe("Open Connections.");
    expect(outcome.program?.goal).toBe("connection.create");
    expect(outcome.program?.instructions).toHaveLength(3);
    expect(outcome.guideError).toBeNull();
    expect(agent.calls()).toHaveLength(1);
  });

  it("reads a guide out of the answer when the port did not separate it", async () => {
    const agent = fakeAgentReplanning([
      {
        answer: ["Open Connections.", "", fenced(VALID_GUIDE)].join("\n"),
      },
    ]);
    const outcome = await runSupportTurn(agent, request(), VOCABULARY, {
      signal: new AbortController().signal,
    });
    expect(outcome.answer).toBe("Open Connections.");
    expect(outcome.program).not.toBeNull();
  });

  it("keeps the answer when the guide never compiles, and retries exactly once", async () => {
    const agent = fakeAgentReplanning([
      { answer: "Open Connections.", guide: fenced(UNKNOWN_DIRECTIVE_GUIDE) },
      { answer: "Still wrong.", guide: fenced(UNKNOWN_DIRECTIVE_GUIDE) },
      { answer: "Never reached.", guide: fenced(VALID_GUIDE) },
    ]);
    const outcome = await runSupportTurn(agent, request(), VOCABULARY, {
      signal: new AbortController().signal,
    });
    expect(outcome.answer).toBe("Open Connections.");
    expect(outcome.program).toBeNull();
    expect(outcome.guideError?.attempts).toBe(
      SUPPORT_LIMITS.maxGuideRepairAttempts,
    );
    expect(outcome.guideError?.stage).toBe("parse");
    expect(outcome.guideError?.codes).toContain("unknown_instruction");
    expect(agent.calls()).toHaveLength(2);
  });

  it("accepts the repaired program on the one retry it is allowed", async () => {
    const agent = fakeAgentReplanning([
      { answer: "Open Connections.", guide: fenced(UNKNOWN_DIRECTIVE_GUIDE) },
      { answer: "Corrected.", guide: fenced(VALID_GUIDE) },
    ]);
    const outcome = await runSupportTurn(agent, request(), VOCABULARY, {
      signal: new AbortController().signal,
    });
    expect(outcome.program).not.toBeNull();
    expect(outcome.guideError).toBeNull();
    expect(agent.calls()).toHaveLength(2);
    expect(outcome.answer).toBe("Open Connections.");
  });

  it("sends the repair instruction, not the rejected program", async () => {
    const agent = fakeAgentReplanning([
      { answer: "Open Connections.", guide: fenced(UNKNOWN_DIRECTIVE_GUIDE) },
      { answer: "Corrected.", guide: fenced(VALID_GUIDE) },
    ]);
    await runSupportTurn(agent, request(), VOCABULARY, {
      signal: new AbortController().signal,
    });
    const retry = agent.calls()[1];
    expect(retry?.question).toContain("unknown_instruction");
    expect(retry?.question).not.toContain("#login");
    expect(retry?.question).not.toContain("click");
  });

  it("reports an identifier the application does not declare", async () => {
    const agent = fakeAgentReplanning([
      { answer: "Open Billing.", guide: fenced(UNKNOWN_TARGET_GUIDE) },
    ]);
    const outcome = await runSupportTurn(agent, request(), VOCABULARY, {
      signal: new AbortController().signal,
    });
    expect(outcome.program).toBeNull();
    expect(outcome.guideError?.stage).toBe("validate");
    expect(outcome.guideError?.codes).toContain("unknown_target");
    expect(outcome.guideError?.issues[0]?.detail).toContain("nav.billing");
  });

  it("does not retry once the caller has aborted", async () => {
    const controller = new AbortController();
    let calls = 0;
    const port: SupportAgentPort = {
      availability(): Promise<SupportAgentAvailability> {
        return Promise.resolve({ kind: "ready" });
      },
      run(): Promise<SupportTurn> {
        calls += 1;
        controller.abort();
        return Promise.resolve({
          answer: "Open Connections.",
          guide: UNKNOWN_DIRECTIVE_GUIDE,
          suggestedQuestions: [],
        });
      },
      destroy(): void {},
    };
    const outcome = await runSupportTurn(port, request(), VOCABULARY, {
      signal: controller.signal,
    });
    expect(calls).toBe(1);
    expect(outcome.answer).toBe("Open Connections.");
    expect(outcome.guideError?.attempts).toBe(0);
  });

  it("keeps the answer when the repair call itself fails", async () => {
    let calls = 0;
    const port: SupportAgentPort = {
      availability(): Promise<SupportAgentAvailability> {
        return Promise.resolve({ kind: "ready" });
      },
      run(): Promise<SupportTurn> {
        calls += 1;
        if (calls > 1) return Promise.reject(new Error("transport died"));
        return Promise.resolve({
          answer: "Open Connections.",
          guide: UNKNOWN_DIRECTIVE_GUIDE,
          suggestedQuestions: [],
        });
      },
      destroy(): void {},
    };
    const outcome = await runSupportTurn(port, request(), VOCABULARY, {
      signal: new AbortController().signal,
    });
    expect(calls).toBe(2);
    expect(outcome.answer).toBe("Open Connections.");
    expect(outcome.program).toBeNull();
    expect(outcome.guideError).not.toBeNull();
  });

  it("caps the suggestions it passes on", async () => {
    const suggestions: string[] = [];
    for (
      let index = 0;
      index < SUPPORT_LIMITS.maxSuggestedQuestions + 4;
      index += 1
    ) {
      suggestions.push(`question ${index}?`);
    }
    const port: SupportAgentPort = {
      availability(): Promise<SupportAgentAvailability> {
        return Promise.resolve({ kind: "ready" });
      },
      run(): Promise<SupportTurn> {
        return Promise.resolve({
          answer: "Open Connections.",
          guide: null,
          suggestedQuestions: suggestions,
        });
      },
      destroy(): void {},
    };
    const outcome = await runSupportTurn(port, request(), VOCABULARY, {
      signal: new AbortController().signal,
    });
    expect(outcome.suggestedQuestions).toHaveLength(
      SUPPORT_LIMITS.maxSuggestedQuestions,
    );
  });

  it("reads the sources line and strips it from the answer", async () => {
    const agent = fakeAgentReplanning([
      {
        answer: [
          "Open Connections, then Add a connection.",
          "",
          "sources: help.connection.create",
        ].join("\n"),
      },
    ]);
    const outcome = await runSupportTurn(agent, request(), VOCABULARY, {
      signal: new AbortController().signal,
    });
    expect(outcome.answer).toBe("Open Connections, then Add a connection.");
    expect(outcome.grounding).toEqual({
      kind: "cited",
      help: [fakeSupportPageContext().help[0]],
    });
  });

  it("keeps the sources line ahead of a guide block", async () => {
    const agent = fakeAgentReplanning([
      {
        answer: [
          "Open Connections.",
          "Sources: `help.connection.create`, help.lock",
          "",
          fenced(VALID_GUIDE),
        ].join("\n"),
      },
    ]);
    const outcome = await runSupportTurn(agent, request(), VOCABULARY, {
      signal: new AbortController().signal,
    });
    expect(outcome.answer).toBe("Open Connections.");
    expect(outcome.program).not.toBeNull();
    expect(outcome.grounding.kind).toBe("cited");
    if (outcome.grounding.kind !== "cited") return;
    expect(outcome.grounding.help.map((entry) => entry.id)).toEqual([
      "help.connection.create",
      "help.lock",
    ]);
  });

  it("treats a citation the context never offered as no citation", async () => {
    const agent = fakeAgentReplanning([
      { answer: "Go to Identity.schema.\nsources: help.identity.schema" },
    ]);
    const outcome = await runSupportTurn(agent, request(), VOCABULARY, {
      signal: new AbortController().signal,
    });
    expect(outcome.answer).toBe("Go to Identity.schema.");
    expect(outcome.grounding).toEqual({ kind: "uncited" });
  });

  it("distinguishes an honest none from a missing line", async () => {
    const honest = await runSupportTurn(
      fakeAgentReplanning([
        { answer: "Nothing written covers that.\nsources: none" },
      ]),
      request(),
      VOCABULARY,
      { signal: new AbortController().signal },
    );
    expect(honest.grounding).toEqual({ kind: "none" });
    expect(honest.answer).toBe("Nothing written covers that.");
    const silent = await runSupportTurn(
      fakeAgentReplanning([{ answer: "Click the Add button." }]),
      request(),
      VOCABULARY,
      { signal: new AbortController().signal },
    );
    expect(silent.grounding).toEqual({ kind: "uncited" });
    expect(silent.answer).toBe("Click the Add button.");
  });

  it("refuses to send a request that fails the egress boundary", async () => {
    const agent = fakeAgentReplanning([{ answer: "unused" }]);
    const hostile: SupportRequest = {
      question: "hello",
      history: [{ role: "user", text: "hi" }],
      context: {
        version: 1,
        pageId: "connections",
        route: "/connections",
        targets: [],
        routes: [],
        state: [],
        capabilities: [],
        goals: [],
        help: [],
        tools: [],
      },
    };
    const outcome = await runSupportTurn(agent, hostile, VOCABULARY, {
      signal: new AbortController().signal,
    });
    expect(outcome.answer).toBe("unused");
    expect(agent.calls()).toHaveLength(1);
    expect(agent.calls()[0]).not.toBe(hostile);
  });
});

describe("guideRepairInstruction", () => {
  const issues: readonly GuideCompileIssue[] = [
    {
      code: "unknown_instruction",
      line: 3,
      column: 1,
      detail: "This directive is not part of the guide language.",
    },
    {
      code: "trailing_content",
      line: 4,
      column: 9,
      detail: "",
    },
  ];

  it("names the codes and restates the closed grammar", () => {
    const instruction = guideRepairInstruction(issues);
    expect(instruction).toContain("unknown_instruction");
    expect(instruction).toContain("trailing_content");
    expect(instruction).toContain("fenced `guide` block");
    expect(instruction).toContain("do not repeat the rejected program back");
  });

  it("stays a sentence even with no diagnostics at all", () => {
    expect(guideRepairInstruction([])).toContain("It failed to parse.");
  });
});
