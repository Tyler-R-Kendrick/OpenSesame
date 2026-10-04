/** @vitest-environment jsdom */

/**
 * Locking the vault, at each of the four moments it is awkward.
 *
 * The runtime suite proves `cancel("lock")` clears its renderer, and the panel
 * suite proves the transcript goes when the vault locks. Neither drives the
 * composition: the controller, the real support session, the real target
 * registry and the tutorial card are four separate owners of state that a lock
 * has to reach, and the only way to know it reaches all four is to lock while
 * each of them is holding something.
 *
 * The provider used here ignores its abort signal, so every case also answers
 * the question the well-behaved fakes cannot: what happens when the model
 * replies to a conversation that no longer exists.
 */

import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  clearMountedGuideTargets,
  isMountedGuideTarget,
} from "@opensesame/app-core/tutorial/registry/targets.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  type SupportController,
  type SupportSessionDependencies,
  createSupportController,
  supportSessionSeams,
} from "../../session.js";
import {
  type DeferredSupportAgent,
  type DomEngine,
  createDeferredSupportAgent,
  createDomEngine,
  guideSource,
  liveOverlayCount,
  mountCoach,
  settle,
  waitUntil,
} from "./harness.js";

type Wired = {
  readonly controller: SupportController;
  readonly engine: DomEngine;
  readonly agent: DeferredSupportAgent;
  /** Fires the lock exactly the way `SupportProvider` subscribes it. */
  lock(): void;
  dispose(): void;
};

function wire(): Wired {
  const agent = createDeferredSupportAgent();
  const engine = createDomEngine(agent);
  const lockHandlers = new Set<() => void>();
  const dependencies: SupportSessionDependencies = {
    loadEngine: () => Promise.resolve(engine),
    onLock: (handler) => {
      lockHandlers.add(handler);
      return () => {
        lockHandlers.delete(handler);
      };
    },
    clearTargets: clearMountedGuideTargets,
  };
  const controller = createSupportController(dependencies);
  const unmountCard = mountCoach(controller);
  const stop = dependencies.onLock(() => controller.lock());
  return {
    controller,
    engine,
    agent,
    lock: () => {
      for (const handler of [...lockHandlers]) handler();
    },
    dispose: () => {
      stop();
      unmountCard();
      controller.destroy();
      engine.targets.unmountAll();
      document.body.replaceChildren();
    },
  };
}

const HIGHLIGHT = guideSource(
  'focus "shell.lock" "This is the lock." side=top',
  "pause",
);

const ARMED_WAIT = guideSource(
  'focus "shell.lock" "Press it whenever you step away." side=top',
  'wait target "shell.lock" event=activate timeout=30000',
);

const ANNOTATION = guideSource(
  'annotate "shell.lock" "Locking drops the keys." side=bottom',
  "pause",
);

afterEach(() => {
  document.body.replaceChildren();
});

describe("locking while a model request is in flight", () => {
  it("empties the transcript and renders nothing when the answer lands late", async () => {
    const wired = wire();
    try {
      const asking = wired.controller.ask("how do I lock the vault?");
      await waitUntil(() => wired.agent.pending() === 1);
      expect(wired.controller.view().transcript).toHaveLength(1);
      expect(wired.controller.view().thinking).toBe(true);

      wired.lock();

      expect(wired.controller.view().transcript).toEqual([]);
      expect(wired.controller.view().ready).toBe(false);
      expect(wired.engine.destroyed()).toBe(true);
      expect(wired.agent.destroyed()).toBe(true);

      // The provider answers anyway, with a program that would have drawn.
      wired.agent.settle({
        answer: "Press the lock on the statusline.",
        guide: HIGHLIGHT,
        suggestedQuestions: [],
      });
      await asking;
      await settle();

      expect(wired.controller.view().transcript).toEqual([]);
      expect(wired.engine.session.messages()).toEqual([]);
      expect(liveOverlayCount()).toBe(0);
    } finally {
      wired.dispose();
    }
  });
});

describe("locking while a guide is on screen", () => {
  it("tears down an armed wait, its timers and its overlays", async () => {
    const wired = wire();
    try {
      const running = wired.controller.startGuide(ARMED_WAIT);
      await waitUntil(() => liveOverlayCount() > 0);
      await waitUntil(
        () => wired.controller.view().guide?.status === "waiting",
      );

      const control = wired.engine.targets.element("shell.lock");
      wired.lock();
      await running;
      await settle();

      expect(liveOverlayCount()).toBe(0);
      expect(wired.engine.clock.pending()).toBe(0);
      expect(isMountedGuideTarget("shell.lock")).toBe(false);

      // The person clicks the control the torn-down guide was waiting on.
      control.dispatchEvent(new MouseEvent("click", { bubbles: true }));
      await settle();
      expect(liveOverlayCount()).toBe(0);
      expect(wired.controller.view().guide).toBeNull();
    } finally {
      wired.dispose();
    }
  });

  it("tears down the step a tutorial is holding on", async () => {
    const wired = wire();
    try {
      void wired.controller.startGuide(HIGHLIGHT);
      await waitUntil(() => liveOverlayCount() > 0);
      expect(wired.controller.view().guide?.status).toBe("waiting");

      wired.lock();
      await settle();

      expect(liveOverlayCount()).toBe(0);
      expect(wired.controller.view().guide).toBeNull();
    } finally {
      wired.dispose();
    }
  });

  it("tears down a step that annotates, as it does one that highlights", async () => {
    const wired = wire();
    try {
      void wired.controller.startGuide(ANNOTATION);
      await waitUntil(() => liveOverlayCount() > 0);

      wired.lock();
      await settle();

      expect(liveOverlayCount()).toBe(0);
      expect(wired.controller.view().guide).toBeNull();
    } finally {
      wired.dispose();
    }
  });
});

describe("after a lock", () => {
  it("cannot be driven again by a guide compiled before it", async () => {
    const wired = wire();
    try {
      void wired.controller.startGuide(HIGHLIGHT);
      await waitUntil(() => liveOverlayCount() > 0);
      wired.lock();
      await settle();

      // A caller that kept the source and asks again gets a fresh engine over
      // a registry with nothing mounted, so nothing is lit: the control the
      // old guide pointed at is gone, and a card with no control to point at
      // is all the tutorial can be.
      void wired.controller.startGuide(HIGHLIGHT);
      await settle();

      expect(document.querySelectorAll(".coach__ring")).toHaveLength(0);
    } finally {
      wired.dispose();
    }
  });
});

describe("the lock the application actually subscribes to", () => {
  it("is the vault's own, so nothing on the model's side can withhold it", async () => {
    await vaultStore.createGuest();
    const agent = createDeferredSupportAgent();
    const engine = createDomEngine(agent);
    const controller = createSupportController({
      loadEngine: () => Promise.resolve(engine),
      onLock: supportSessionSeams.onLock,
      clearTargets: clearMountedGuideTargets,
    });
    const stop = supportSessionSeams.onLock(() => controller.lock());
    const unmountCard = mountCoach(controller);
    try {
      void controller.startGuide(HIGHLIGHT);
      await waitUntil(() => liveOverlayCount() > 0);

      vaultStore.lock();
      await settle();

      expect(liveOverlayCount()).toBe(0);
      expect(controller.view().transcript).toEqual([]);
      expect(engine.destroyed()).toBe(true);
    } finally {
      stop();
      unmountCard();
      controller.destroy();
      engine.targets.unmountAll();
    }
  });
});
