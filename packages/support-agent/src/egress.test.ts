import {
  type BoundaryValue,
  type MutableBoundaryObject,
  overlapCast,
} from "@opensesame/os-domain";
import { describe, expect, it } from "vitest";
import {
  SUPPORT_LIMITS,
  type SupportMessage,
  type SupportPageContext,
  type SupportRequest,
} from "./contract.js";
import {
  SupportEgressRefused,
  assertNoStructuralLeak,
  redactionWarning,
  sanitizeSupportRequest,
} from "./egress.js";
import { fakeSupportPageContext } from "./fake.js";

/**
 * The point of the boundary is that a declared type is not evidence, so the
 * fixtures below deliberately disagree with `SupportRequest`. That is exactly
 * the input the boundary exists to refuse.
 */
function asRequest(value: BoundaryValue): SupportRequest {
  // SAFETY: this fixture supplies runtime data whose declared type is a lie,
  // which is the boundary contract under test; nothing downstream trusts it.
  return overlapCast(value);
}

/** The same context, typed loosely so it can sit inside a hostile fixture. */
function contextValue(): BoundaryValue {
  // SAFETY: fakeSupportPageContext already builds a plain data tree; the cast
  // only widens its readonly arrays so the fixture can nest it.
  return overlapCast(fakeSupportPageContext());
}

function legitimateRequest(): SupportRequest {
  return {
    question: "How do I add a connection?",
    history: [],
    context: fakeSupportPageContext(),
  };
}

describe("sanitizeSupportRequest", () => {
  it("passes a legitimate request through", () => {
    const sanitized = sanitizeSupportRequest(legitimateRequest());
    expect(sanitized.question).toBe("How do I add a connection?");
    expect(sanitized.context.targets).toHaveLength(3);
    expect(sanitized.context.targets[0]?.id).toBe("nav.connections");
    expect(sanitized.context.state[0]).toEqual({
      id: "vault.unlocked",
      value: true,
    });
  });

  it("rebuilds rather than copies, so later mutation of the input is invisible", () => {
    const history: SupportMessage[] = [{ role: "user", text: "earlier" }];
    const context = fakeSupportPageContext();
    const request: SupportRequest = {
      question: "How do I add a connection?",
      history,
      context,
    };
    const sanitized = sanitizeSupportRequest(request);

    expect(sanitized).not.toBe(request);
    expect(sanitized.history).not.toBe(history);
    expect(sanitized.context).not.toBe(context);
    expect(sanitized.context.targets).not.toBe(context.targets);
    expect(sanitized.context.targets[0]).not.toBe(context.targets[0]);

    history.push({ role: "assistant", text: "added later" });
    expect(sanitized.history).toHaveLength(1);
    expect(sanitized.history[0]?.text).toBe("earlier");
  });

  it("refuses an element-like object anywhere in the payload", () => {
    const context = fakeSupportPageContext();
    const request = asRequest({
      question: "what is this",
      history: [],
      context: {
        version: 1,
        pageId: "connections",
        route: "/connections",
        targets: [
          {
            id: "nav.connections",
            description: "nav",
            role: "navigation",
            mounted: true,
            element: { nodeType: 1, tagName: "BUTTON" },
          },
        ],
        routes: [...context.routes],
        state: [],
        capabilities: [],
        goals: [],
      },
    });
    expect(() => sanitizeSupportRequest(request)).toThrow(SupportEgressRefused);
  });

  it("refuses a function reaching the boundary", () => {
    const request = asRequest({
      question: "what is this",
      history: [],
      context: {
        version: 1,
        pageId: "connections",
        route: "/connections",
        targets: [],
        routes: [],
        state: [],
        capabilities: [],
        goals: [],
        onSelect: () => undefined,
      },
    });
    expect(() => sanitizeSupportRequest(request)).toThrow(SupportEgressRefused);
  });

  it("refuses a payload carrying a password", () => {
    const request = asRequest({
      question: "why does this not work",
      history: [],
      context: contextValue(),
      password: "correct horse battery staple",
    });
    expect(() => sanitizeSupportRequest(request)).toThrow(SupportEgressRefused);
  });

  it("refuses a vault-record-like payload", () => {
    const request = asRequest({
      question: "which account is this",
      history: [],
      context: contextValue(),
      items: [{ id: "1", title: "Bank" }],
    });
    expect(() => sanitizeSupportRequest(request)).toThrow(SupportEgressRefused);
  });

  it("refuses an unexpected key even when it looks harmless", () => {
    const request = asRequest({
      question: "hello",
      history: [],
      context: contextValue(),
      sessionId: "s-1",
    });
    expect(() => sanitizeSupportRequest(request)).toThrow(SupportEgressRefused);
  });

  it("refuses a missing key rather than sending a partial context", () => {
    const request = asRequest({
      question: "hello",
      history: [],
    });
    expect(() => sanitizeSupportRequest(request)).toThrow(SupportEgressRefused);
  });

  it("refuses an undeclared target role", () => {
    const request = asRequest({
      question: "hello",
      history: [],
      context: {
        version: 1,
        pageId: "connections",
        route: "/connections",
        targets: [
          {
            id: "nav.connections",
            description: "nav",
            role: "wildcard",
            mounted: true,
          },
        ],
        routes: [],
        state: [],
        capabilities: [],
        goals: [],
      },
    });
    expect(() => sanitizeSupportRequest(request)).toThrow(SupportEgressRefused);
  });

  it("refuses an over-long identifier rather than truncating it into another one", () => {
    const request = asRequest({
      question: "hello",
      history: [],
      context: {
        version: 1,
        pageId: "connections",
        route: "/connections",
        targets: [],
        routes: [],
        state: [{ id: `vault.${"x".repeat(80)}`, value: true }],
        capabilities: [],
        goals: [],
      },
    });
    expect(() => sanitizeSupportRequest(request)).toThrow(SupportEgressRefused);
  });
});

describe("sanitizeSupportRequest limits", () => {
  it("clamps the question to maxQuestionChars", () => {
    const sanitized = sanitizeSupportRequest({
      question: "q".repeat(SUPPORT_LIMITS.maxQuestionChars + 500),
      history: [],
      context: fakeSupportPageContext(),
    });
    expect(sanitized.question).toHaveLength(SUPPORT_LIMITS.maxQuestionChars);
  });

  it("keeps only the most recent maxHistoryTurns", () => {
    const history: SupportMessage[] = [];
    for (
      let index = 0;
      index < SUPPORT_LIMITS.maxHistoryTurns + 6;
      index += 1
    ) {
      history.push({ role: "user", text: `turn-${index}` });
    }
    const sanitized = sanitizeSupportRequest({
      question: "hello",
      history,
      context: fakeSupportPageContext(),
    });
    expect(sanitized.history).toHaveLength(SUPPORT_LIMITS.maxHistoryTurns);
    expect(sanitized.history[0]?.text).toBe("turn-6");
    expect(sanitized.history.at(-1)?.text).toBe(
      `turn-${SUPPORT_LIMITS.maxHistoryTurns + 5}`,
    );
  });

  it("clamps each history message to maxHistoryMessageChars", () => {
    const sanitized = sanitizeSupportRequest({
      question: "hello",
      history: [
        {
          role: "assistant",
          text: "m".repeat(SUPPORT_LIMITS.maxHistoryMessageChars + 100),
        },
      ],
      context: fakeSupportPageContext(),
    });
    expect(sanitized.history[0]?.text).toHaveLength(
      SUPPORT_LIMITS.maxHistoryMessageChars,
    );
  });

  it("caps every context list at its budget", () => {
    const base = fakeSupportPageContext();
    const targets: BoundaryValue[] = [];
    for (let index = 0; index < SUPPORT_LIMITS.maxTargets + 10; index += 1) {
      targets.push({
        id: `target.n${index}`,
        description: "a control",
        role: "action",
        mounted: true,
      });
    }
    const goals: BoundaryValue[] = [];
    for (let index = 0; index < SUPPORT_LIMITS.maxGoals + 10; index += 1) {
      goals.push({ id: `goal.n${index}`, title: "a goal" });
    }
    const request = asRequest({
      question: "hello",
      history: [],
      context: {
        version: 1,
        pageId: base.pageId,
        route: base.route,
        targets,
        routes: [],
        state: [],
        capabilities: [],
        goals,
        help: [],
        tools: [],
      },
    });
    const sanitized = sanitizeSupportRequest(request);
    expect(sanitized.context.targets).toHaveLength(SUPPORT_LIMITS.maxTargets);
    expect(sanitized.context.goals).toHaveLength(SUPPORT_LIMITS.maxGoals);
  });

  it("clamps an over-long description instead of refusing it", () => {
    const request = asRequest({
      question: "hello",
      history: [],
      context: {
        version: 1,
        pageId: "connections",
        route: "/connections",
        targets: [
          {
            id: "nav.connections",
            description: "d".repeat(4000),
            role: "navigation",
            mounted: true,
          },
        ],
        routes: [],
        state: [],
        capabilities: [],
        goals: [],
        help: [],
        tools: [],
      },
    });
    const sanitized = sanitizeSupportRequest(request);
    expect(sanitized.context.targets[0]?.description).toHaveLength(240);
  });
});

describe("sanitizeSupportRequest written help and tools", () => {
  it("rebuilds help entries and tool descriptions field by field", () => {
    const sanitized = sanitizeSupportRequest(legitimateRequest());
    expect(sanitized.context.help).toEqual(fakeSupportPageContext().help);
    expect(sanitized.context.tools).toEqual(fakeSupportPageContext().tools);
    expect(sanitized.context.help[0]).not.toBe(
      legitimateRequest().context.help[0],
    );
  });

  it("refuses a help entry or tool that carries an undeclared key", () => {
    const base = fakeSupportPageContext();
    const withElement: MutableBoundaryObject = overlapCast({ ...base });
    withElement.help = [{ ...base.help[0], element: {} }];
    expect(() =>
      sanitizeSupportRequest(
        asRequest({ question: "hello", history: [], context: withElement }),
      ),
    ).toThrow(SupportEgressRefused);
    const withExecute: MutableBoundaryObject = overlapCast({ ...base });
    withExecute.tools = [{ ...base.tools[0], execute: () => null }];
    expect(() =>
      sanitizeSupportRequest(
        asRequest({ question: "hello", history: [], context: withExecute }),
      ),
    ).toThrow(SupportEgressRefused);
  });

  it("caps help entries and tools at their budgets and clamps an answer", () => {
    const base = fakeSupportPageContext();
    const help: BoundaryValue[] = [];
    for (let index = 0; index < SUPPORT_LIMITS.maxHelpEntries + 3; index += 1) {
      help.push({
        id: `help.n${index}`,
        title: "a topic",
        answer: "a".repeat(SUPPORT_LIMITS.maxHelpAnswerChars + 50),
        goal: null,
      });
    }
    const tools: BoundaryValue[] = [];
    for (let index = 0; index < SUPPORT_LIMITS.maxTools + 3; index += 1) {
      tools.push({
        name: `opensesame_n${index}`,
        description: "a tool",
        exposed: false,
      });
    }
    const oversized: MutableBoundaryObject = overlapCast({ ...base });
    oversized.help = help;
    oversized.tools = tools;
    const sanitized = sanitizeSupportRequest(
      asRequest({ question: "hello", history: [], context: oversized }),
    );
    expect(sanitized.context.help).toHaveLength(SUPPORT_LIMITS.maxHelpEntries);
    expect(sanitized.context.help[0]?.answer).toHaveLength(
      SUPPORT_LIMITS.maxHelpAnswerChars,
    );
    expect(sanitized.context.tools).toHaveLength(SUPPORT_LIMITS.maxTools);
  });
});

describe("assertNoStructuralLeak", () => {
  const context: SupportPageContext = fakeSupportPageContext();

  it("accepts a plain data tree", () => {
    expect(() =>
      assertNoStructuralLeak({
        question: "hello",
        history: [{ role: "user", text: "hi" }],
        depth: { deeper: [1, true, null, "text"] },
      }),
    ).not.toThrow();
    expect(() => assertNoStructuralLeak(context.route)).not.toThrow();
  });

  it("refuses a function", () => {
    expect(() => assertNoStructuralLeak({ callback: () => undefined })).toThrow(
      SupportEgressRefused,
    );
  });

  it("refuses an object carrying nodeType", () => {
    expect(() =>
      assertNoStructuralLeak({ nested: { nodeType: 1, textContent: "x" } }),
    ).toThrow(SupportEgressRefused);
  });

  it("refuses a document-like or window-like object", () => {
    expect(() =>
      assertNoStructuralLeak({ view: { document: {}, location: {} } }),
    ).toThrow(SupportEgressRefused);
  });

  it("refuses every denylisted key, however it is spelled", () => {
    const denied = [
      "password",
      "secret",
      "token",
      "totp",
      "privateKey",
      "private_key",
      "recoveryCode",
      "cardNumber",
      "note",
      "items",
      "folders",
      "vault",
      "cookie",
      "authorization",
      "Authorization",
      "userToken",
    ];
    for (const key of denied) {
      expect(() => assertNoStructuralLeak({ [key]: "x" })).toThrow(
        SupportEgressRefused,
      );
    }
  });

  it("refuses an accessor rather than invoking it", () => {
    let read = 0;
    const trap = Object.defineProperty({}, "answer", {
      enumerable: true,
      configurable: true,
      get(): string {
        read += 1;
        return "leaked";
      },
    });
    expect(() => assertNoStructuralLeak({ trap })).toThrow(
      SupportEgressRefused,
    );
    expect(read).toBe(0);
  });

  it("refuses a reference cycle", () => {
    const cycle: MutableBoundaryObject = {};
    cycle.child = cycle;
    expect(() => assertNoStructuralLeak(cycle)).toThrow(SupportEgressRefused);
  });

  it("refuses a host type masquerading as data", () => {
    expect(() => assertNoStructuralLeak({ at: new Date() })).toThrow(
      SupportEgressRefused,
    );
    expect(() => assertNoStructuralLeak({ index: new Map() })).toThrow(
      SupportEgressRefused,
    );
  });

  it("names the field but never the value it refused", () => {
    let refusal: SupportEgressRefused | null = null;
    try {
      assertNoStructuralLeak({ profile: { password: "hunter2" } });
    } catch (cause) {
      refusal = cause instanceof SupportEgressRefused ? cause : null;
    }
    expect(refusal).not.toBeNull();
    expect(refusal?.code).toBe("EGRESS_REFUSED");
    expect(refusal?.field).toBe("value.profile.password");
    expect(refusal?.message).not.toContain("hunter2");
  });
});

describe("redactionWarning", () => {
  it("is fixed and honest about what it cannot do", () => {
    const warning = redactionWarning();
    expect(warning).toBe(redactionWarning());
    expect(warning).toContain("leave your device");
    expect(warning).toContain("Do not paste a password");
    expect(warning).toContain("nothing here can tell that a secret is hidden");
    expect(warning.toLowerCase()).not.toContain("redact");
    expect(warning.toLowerCase()).not.toContain("we remove");
  });
});
