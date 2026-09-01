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
    if (program !== null) await active.runtime.start(program);

    expect(active.renderer.renderCalls()).toEqual([
      {
        kind: "focus",
        target: "shell.lock",
        message: "The current walkthrough.",
        side: "top",
      },
    ]);
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

  it("fails closed rather than drawing, when it was compiled before the move", async () => {
    const active = open("/vault");
    const program = active.compile(STALE_GUIDE);
    expect(program).not.toBeNull();

    // The person navigated: the route's controls came off the page.
    active.targets.unmount("vault.create");
    active.routes.go("/connections");

    if (program === null) throw new Error("fixture did not compile");
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
    const waiting = active.runtime.start({
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
    });
    await settle();
    expect(active.clock.pending()).toBe(1);

    const replacement = active.compile(CURRENT_GUIDE);
    if (replacement === null) throw new Error("fixture did not compile");
    const second = active.runtime.start(replacement);

    expect(await waiting).toEqual({
      kind: "cancelled",
      goal: "vault.lock",
      reason: "superseded",
    });
    expect(await second).toEqual({ kind: "completed", goal: "vault.lock" });
    expect(active.clock.pending()).toBe(0);
    expect(active.runtime.snapshot().status).toBe("done");
  });
});
