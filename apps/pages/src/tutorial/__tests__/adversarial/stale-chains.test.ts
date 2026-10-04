/** @vitest-environment jsdom */

/**
 * Work that arrives after the world it was planned for has gone.
 *
 * Both halves of this feature are asynchronous against a page that moves: a
 * model answers on its own schedule, and a trajectory is compiled against the
 * vocabulary of the route the person was on when they asked. The session suite
 * proves a superseded *answer* is dropped; nothing proves the guide attached to
 * that answer is dropped with it, or that a program compiled for one route
 * cannot draw on another.
 */

import { TOUR_APPEAR_GRACE_MS } from "@opensesame/guide-runtime";
import {
  type SupportSession,
  createSupportSession,
} from "@opensesame/support-agent";
import { afterEach, describe, expect, it } from "vitest";
import {
  type DeferredSupportAgent,
  type SupportChain,
  createDeferredSupportAgent,
  createSupportChain,
  guideSource,
  settle,
  waitUntil,
  walkToEnd,
} from "./harness.js";

let chain: SupportChain | null = null;

function open(route = "/vault"): SupportChain {
  const built = createSupportChain(route);
  chain = built;
  return built;
}

function sessionFor(
  active: SupportChain,
  agent: DeferredSupportAgent,
): SupportSession {
  return createSupportSession({
    port: agent,
    vocabulary: active.vocabulary,
    readContext: () => active.context,
  });
}

afterEach(() => {
  chain?.dispose();
  chain = null;
  document.body.replaceChildren();
});

const STALE_GUIDE = guideSource(
  'focus "vault.create" "The stale walkthrough." side=bottom',
  "end",
);

const CURRENT_GUIDE = guideSource(
  'focus "shell.lock" "The current walkthrough." side=top',
  "end",
);

describe("a support answer that lost its race", () => {
  it("brings no walkthrough with it when it lands after a newer one", async () => {
    const active = open();
    const agent = createDeferredSupportAgent();
    const session = sessionFor(active, agent);

    const first = session.ask("what is on this screen?");
    await waitUntil(() => agent.pending() === 1);
    const second = session.ask("no, how do I lock?");
    await waitUntil(() => agent.pending() === 2);

    // The second question is answered first; the first answer arrives after,
    // carrying a walkthrough of its own for a screen nobody asked about now.
    agent.settle(
      {
        answer: "Press the lock.",
        guide: CURRENT_GUIDE,
        suggestedQuestions: [],
      },
      1,
    );
    await settle();
    agent.settle({
      answer: "This is the vault list.",
      guide: STALE_GUIDE,
      suggestedQuestions: [],
    });
    await Promise.all([first, second]);
    await settle();

    const snapshot = session.snapshot();
    expect(snapshot.program?.instructions[0]).toMatchObject({
      kind: "focus",
      target: "shell.lock",
    });
    expect(snapshot.messages.at(-1)?.text).toBe("Press the lock.");

    const program = snapshot.program;
    expect(program).not.toBeNull();
    if (program === null) throw new Error("fixture did not compile");
    const running = active.runGuide(program, "model");
    await settle();

    expect(active.renderer.renderCalls().map((call) => call.kind)).toEqual([
      "scroll",
      "focus",
    ]);
    expect(active.renderer.renderCalls()).toContainEqual({
      kind: "focus",
      target: "shell.lock",
      message: "The current walkthrough.",
      side: "top",
    });
    expect(await walkToEnd(active, running)).toEqual({
      kind: "completed",
      goal: "vault.lock",
    });
  });
});

describe("a walkthrough compiled for another route", () => {
  it("does not compile at all once the page has moved", () => {
    const onVault = open("/vault");
    expect(onVault.compile(STALE_GUIDE)).not.toBeNull();
    onVault.dispose();
    chain = null;

    const onConnections = open("/connections");
    expect(onConnections.compile(STALE_GUIDE)).toBeNull();
  });

  it("degrades to the model's text after the grace, when it was compiled before the move", async () => {
    const active = open("/vault");
    const program = active.compile(STALE_GUIDE);
    expect(program).not.toBeNull();

    // The person navigated: the route's controls came off the page.
    active.targets.unmount("vault.create");
    active.routes.go("/connections");

    if (program === null) throw new Error("fixture did not compile");
    const running = active.runGuide(program, "model");
    await active.clock.advance(0);
    await active.clock.advance(TOUR_APPEAR_GRACE_MS - 1);
    // Still giving the control a moment to appear: nothing is on the card yet.
    expect(active.runtime.snapshot().tour?.degraded).toBe(false);

    await active.clock.advance(1);
    expect(active.runtime.snapshot()).toMatchObject({
      status: "waiting",
      tour: {
        kind: "point",
        target: "vault.create",
        message: "The stale walkthrough.",
        degraded: true,
      },
    });
    // Nothing is pointed at, scrolled to, or navigated to.
    expect(active.renderer.renderCalls()).toEqual([]);
    expect(active.routes.navigations()).toEqual([]);
    expect(active.routes.current()).toBe("/connections");

    expect(await walkToEnd(active, running)).toEqual({
      kind: "completed",
      goal: "vault.lock",
    });
    expect(active.renderer.renderCalls()).toEqual([]);
    expect(active.routes.navigations()).toEqual([]);
  });

  it("navigates only when the person advances past the step that precedes it", async () => {
    const active = open("/vault");
    const program = active.compile(
      guideSource(
        'focus "shell.lock" "Here first." side=top',
        'navigate "/vault/health"',
        'say "Then over there."',
        "end",
      ),
    );
    if (program === null) throw new Error("fixture did not compile");

    const running = active.runGuide(program, "model");
    await settle();
    await active.clock.advance(TOUR_APPEAR_GRACE_MS);
    expect(active.runtime.snapshot().tour?.message).toBe("Here first.");
    expect(active.routes.navigations()).toEqual([]);

    active.nextStep();
    await active.clock.advance(0);
    expect(active.routes.navigations()).toEqual(["/vault/health"]);
    expect(active.runtime.snapshot().tour?.message).toBe("Then over there.");
    await walkToEnd(active, running);
  });
});

describe("the runtime API, started in auto mode", () => {
  // `runtime.start(program)` with no options is `auto`. The app never starts a
  // guide this way (every guide is a tour), so this pins the runtime's own
  // contract for any caller that does, and is not evidence about the app.
  it("fails closed rather than drawing a program compiled before the move", async () => {
    const active = open("/vault");
    const program = active.compile(STALE_GUIDE);
    if (program === null) throw new Error("fixture did not compile");

    active.targets.unmount("vault.create");
    active.routes.go("/connections");
    const outcome = await active.runtime.start(program);

    expect(outcome).toEqual({
      kind: "failed",
      goal: "vault.lock",
      error: { code: "TARGET_NOT_MOUNTED", detail: "vault.create" },
    });
    expect(active.renderer.renderCalls()).toEqual([]);
    expect(active.routes.navigations()).toEqual([]);
  });
});

describe("only one walkthrough is ever live", () => {
  it("cancels the run in flight rather than drawing over it", async () => {
    const active = open();
    const waiting = active.runGuide(
      {
        version: 1,
        goal: "vault.lock",
        instructions: [
          {
            kind: "focus",
            target: "shell.lock",
            message: "First.",
            side: null,
          },
          {
            kind: "wait",
            subject: "target",
            target: "shell.lock",
            event: "activate",
            timeoutMs: 30_000,
          },
        ],
      },
      "model",
    );
    await settle();
    expect(active.runtime.snapshot().tour?.message).toBe("First.");

    const replacement = active.compile(CURRENT_GUIDE);
    if (replacement === null) throw new Error("fixture did not compile");
    const second = active.runGuide(replacement, "model");

    expect(await waiting).toEqual({
      kind: "cancelled",
      goal: "vault.lock",
      reason: "superseded",
    });
    await settle();
    expect(active.runtime.snapshot().tour?.message).toBe(
      "The current walkthrough.",
    );
    expect(await walkToEnd(active, second)).toEqual({
      kind: "completed",
      goal: "vault.lock",
    });
    expect(active.clock.pending()).toBe(0);
    expect(active.runtime.snapshot().status).toBe("done");
  });
});
