/** @vitest-environment jsdom */

/**
 * A hostile model, driven end to end.
 *
 * The parser suite proves each directive is rejected; this one proves the
 * rejection survives the trip through the egress boundary, the turn splitter,
 * the repair retry, the app's live vocabulary and the runtime — and that the
 * renderer and the router are untouched at the end of it. The distinction
 * matters because none of those layers is the parser: any one of them could
 * hold a program the parser refused and hand it on.
 */

import { GUIDE_INSTRUCTION_NAMES } from "@opensesame/guide-lang";
import {
  type FakeSupportAgent,
  type SupportRequest,
  fakeAgentAnswering,
  runSupportTurn,
} from "@opensesame/support-agent";
import fc from "fast-check";
import { afterEach, describe, expect, it } from "vitest";
import { resolveGuideTargetElement } from "../../registry/targets.js";
import {
  type SupportChain,
  createSupportChain,
  guideSource,
} from "./harness.js";

let chain: SupportChain | null = null;

function open(route = "/vault"): SupportChain {
  const built = createSupportChain(route);
  chain = built;
  return built;
}

afterEach(() => {
  chain?.dispose();
  chain = null;
  document.body.replaceChildren();
});

function request(active: SupportChain, question: string): SupportRequest {
  return { question, history: [], context: active.context };
}

/**
 * One whole support turn, and then whatever came back, actually run. Driving
 * the run is the point: a test that only asserted "did not compile" would not
 * notice a caller that ran the program anyway.
 */
async function drive(
  active: SupportChain,
  agent: FakeSupportAgent,
  question = "how do I lock the vault?",
): Promise<boolean> {
  const controller = new AbortController();
  const outcome = await runSupportTurn(
    agent,
    request(active, question),
    active.vocabulary,
    { signal: controller.signal },
  );
  if (outcome.program === null) return false;
  await active.runtime.start(outcome.program);
  return true;
}

const HOSTILE_PROGRAMS: readonly { name: string; source: string }[] = [
  {
    name: "click on a selector",
    source: guideSource('click "#reveal-secret"'),
  },
  {
    name: "navigate to a javascript: URL",
    source: guideSource('navigate "javascript:alert(1)"'),
  },
  {
    name: "navigate off-origin",
    source: guideSource('navigate "https://evil.example"'),
  },
  {
    name: "focus an id selector",
    source: guideSource('focus "#password" "x"'),
  },
  {
    name: "focus a descendant selector",
    source: guideSource('focus "div>span" "x"'),
  },
  {
    name: "eval",
    source: guideSource("eval \"globalThis.fetch('https://evil.example')\""),
  },
  {
    name: "execute-tool",
    source: guideSource('execute-tool "opensesame_shared_session_admit"'),
  },
  {
    name: "an unbounded wait on an invented target",
    source: guideSource('wait target "x" event=activate timeout=99999999'),
  },
  {
    name: "four hundred instructions",
    source: guideSource(
      ...Array.from({ length: 400 }, () => 'say "keep going"'),
    ),
  },
];

describe("a model that answers with hostile GuideLang", () => {
  for (const program of HOSTILE_PROGRAMS) {
    it(`draws nothing and goes nowhere for ${program.name}`, async () => {
      const active = open();
      const agent = fakeAgentAnswering("Here is how.", program.source);

      const ran = await drive(active, agent);

      expect(ran).toBe(false);
      expect(active.renderer.calls).toEqual([]);
      expect(active.routes.navigations()).toEqual([]);
      expect(active.routes.current()).toBe("/vault");
      expect(active.clock.pending()).toBe(0);
    });
  }

  it("keeps the prose answer, and asks exactly one repair", async () => {
    const active = open();
    const agent = fakeAgentAnswering(
      "Locking is on the statusline.",
      guideSource('click "#reveal-secret"'),
    );

    const outcome = await runSupportTurn(
      agent,
      request(active, "how do I lock?"),
      active.vocabulary,
      { signal: new AbortController().signal },
    );

    expect(outcome.answer).toBe("Locking is on the statusline.");
    expect(outcome.program).toBeNull();
    expect(outcome.guideError?.stage).toBe("parse");
    expect(agent.calls()).toHaveLength(2);
  });

  it("never repeats the rejected program back to the model", async () => {
    const active = open();
    const source = guideSource(
      'execute-tool "opensesame_shared_session_admit"',
    );
    const agent = fakeAgentAnswering("Here.", source);

    await drive(active, agent);

    const retry = agent.calls()[1];
    expect(retry).toBeDefined();
    expect(retry?.question).not.toContain("execute-tool");
    expect(retry?.question).not.toContain("opensesame_shared_session_admit");
  });

  /**
   * The control. Without it every assertion above would also pass against a
   * harness that had simply been wired wrong.
   */
  it("still draws and navigates for a guide the application authored", async () => {
    const active = open();
    const agent = fakeAgentAnswering(
      "Here.",
      guideSource(
        'focus "shell.lock" "This is the lock." side=top',
        'navigate "/vault/health"',
        "end",
      ),
    );

    const ran = await drive(active, agent);

    expect(ran).toBe(true);
    expect(active.renderer.sequence()).toEqual(["focus", "clear"]);
    expect(active.routes.navigations()).toEqual(["/vault/health"]);
  });
});

describe("the grammar has no production for acting", () => {
  it("names no directive that could click, type, fetch or evaluate", () => {
    for (const forbidden of [
      "click",
      "type",
      "fill",
      "submit",
      "eval",
      "script",
      "selector",
      "fetch",
      "execute-tool",
      "open",
      "reveal",
      "copy",
    ]) {
      expect(GUIDE_INSTRUCTION_NAMES).not.toContain(forbidden);
    }
  });
});

describe("no arbitrary string reaches the page", () => {
  it("never becomes a target the compiler accepts or the registry resolves", () => {
    const active = open();
    fc.assert(
      fc.property(fc.string({ maxLength: 64 }), (candidate) => {
        fc.pre(!active.vocabulary.targets.includes(candidate));
        const program = active.compile(
          guideSource(`focus ${JSON.stringify(candidate)} "x"`),
        );
        expect(program).toBeNull();
        expect(resolveGuideTargetElement(candidate)).toBeNull();
      }),
      { numRuns: 400 },
    );
    expect(active.renderer.calls).toEqual([]);
  });

  it("never becomes a route the compiler accepts", () => {
    const active = open();
    fc.assert(
      fc.property(fc.string({ maxLength: 64 }), (candidate) => {
        fc.pre(!active.vocabulary.routes.includes(candidate));
        expect(
          active.compile(guideSource(`navigate ${JSON.stringify(candidate)}`)),
        ).toBeNull();
      }),
      { numRuns: 400 },
    );
    expect(active.routes.navigations()).toEqual([]);
  });

  it("never becomes a predicate the compiler accepts", () => {
    const active = open();
    fc.assert(
      fc.property(fc.string({ maxLength: 64 }), (candidate) => {
        fc.pre(!active.vocabulary.predicates.includes(candidate));
        expect(
          active.compile(
            guideSource(
              `wait state ${JSON.stringify(candidate)} is=true timeout=1000`,
            ),
          ),
        ).toBeNull();
      }),
      { numRuns: 400 },
    );
  });
});
