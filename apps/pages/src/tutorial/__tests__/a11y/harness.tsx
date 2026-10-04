/**
 * The substrate the accessibility suites in this directory drive.
 *
 * It differs from `ui/support.test.tsx` in one deliberate way: the tutorial
 * card is drawn for real, over real target elements bound in the registry.
 * Accessibility questions about a tutorial — who holds the caret, what the
 * card is called, whether anything animates — are questions about what is in
 * the document, and a renderer that only records calls cannot answer them.
 */
import {
  GUIDE_GOALS,
  HELP_TOPICS,
  guideGoalIds,
} from "@opensesame/app-core/tutorial/registry/goals.js";
import { GUIDE_ROUTES } from "@opensesame/app-core/tutorial/registry/routes.js";
import { guidePredicateIds } from "@opensesame/app-core/tutorial/registry/state.js";
import { guideTargetIds } from "@opensesame/app-core/tutorial/registry/targets.js";

import { buildSupportPageContext } from "@opensesame/app-core/tutorial/registry/context.js";
import {
  clearMountedGuideTargets,
  mountGuideTarget,
  resolveGuideTargetElement,
} from "@opensesame/app-core/tutorial/registry/targets.js";
import { AUTHORED_GUIDE_LIMITS, compileGuide } from "@opensesame/guide-lang";
import type { GuideTargetId } from "@opensesame/guide-lang";
import {
  createFakeRoutes,
  createFakeState,
  createFakeTargets,
  createGuideRuntime,
  createTestClock,
} from "@opensesame/guide-runtime";
import type { FakeSupportAgent } from "@opensesame/support-agent";
import {
  createSupportSession,
  supportVocabulary,
} from "@opensesame/support-agent";
import { cleanup, render, screen, within } from "@testing-library/react";
import type userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { createScrollRenderer } from "../../coach/scroll-renderer.js";
import type { SupportEngine, SupportTransport } from "../../session.js";
import { SupportProvider, supportSessionSeams } from "../../session.js";
import { tourRunner } from "../../tour-runner.js";
import { SupportLauncher } from "../../ui/SupportLauncher.js";

export type TestUser = ReturnType<typeof userEvent.setup>;

/* ---------- real target fixtures ---------- */

export type TargetFixtures = {
  /** The live element bound to a declared id, so a test can assert on focus. */
  element(id: GuideTargetId): HTMLElement;
  release(): void;
};

function mountFixtures(ids: readonly GuideTargetId[]): TargetFixtures {
  const elements = new Map<GuideTargetId, HTMLElement>();
  const detachers: (() => void)[] = [];
  for (const id of ids) {
    const element = document.createElement("button");
    element.type = "button";
    element.textContent = id;
    document.body.appendChild(element);
    elements.set(id, element);
    detachers.push(mountGuideTarget(id, element));
  }
  return {
    element(id) {
      const found = elements.get(id);
      if (!found) throw new Error(`no fixture mounted for ${id}`);
      return found;
    },
    release() {
      for (const detach of detachers) detach();
      detachers.length = 0;
      for (const element of elements.values()) element.remove();
      elements.clear();
    },
  };
}

/* ---------- the engine ---------- */

export type A11yEngine = SupportEngine & {
  readonly agent: FakeSupportAgent;
  /** True once the vault-lock teardown has run through this engine. */
  destroyed(): boolean;
};

export type SupportHarness = {
  readonly engine: A11yEngine;
  readonly fixtures: TargetFixtures;
  /** The routes a walkthrough asked the app to navigate to, in order. */
  navigations(): readonly string[];
  /** How many times teardown asked the registry to drop its bindings. */
  clearedTargets(): number;
};

export type SupportHarnessOptions = {
  readonly agent: FakeSupportAgent;
  readonly transport?: SupportTransport;
  readonly warning?: string | null;
  readonly route?: string;
  readonly reducedMotion?: boolean;
  /** Declared ids to bind to real elements, for tests that watch the page. */
  readonly targets?: readonly GuideTargetId[];
};

const originalSeams = { ...supportSessionSeams };
/**
 * The lock subscription the provider takes out. Held rather than faked so the
 * unsubscribe it is handed is the real one — a provider that stopped
 * unsubscribing would leave a handler here across a suite instead of quietly
 * doing nothing.
 */
const lockHandlers = new Set<() => void>();
let liveFixtures: TargetFixtures | null = null;

export function mountSupport(options: SupportHarnessOptions): SupportHarness {
  const route = options.route ?? "/vault";
  const context = buildSupportPageContext({
    pageId: "a11y",
    route,
    hostReachable: true,
    identityReachable: true,
  });
  const vocabulary = supportVocabulary(context);
  const session = createSupportSession({
    port: options.agent,
    vocabulary,
    readContext: () => context,
  });
  const fixtures = mountFixtures(options.targets ?? []);
  liveFixtures = fixtures;
  const renderer = createScrollRenderer({
    resolveElement: resolveGuideTargetElement,
    reducedMotion: () => options.reducedMotion ?? false,
  });
  const targets = createFakeTargets(guideTargetIds(), vocabulary.targets);
  const routes = createFakeRoutes(vocabulary.routes, route);
  const clock = createTestClock();
  const runtime = createGuideRuntime({
    renderer,
    targets,
    routes,
    state: createFakeState([]),
    clock,
  });
  let torn = false;

  const engine: A11yEngine = {
    transport: options.transport ?? "on-device",
    warning: options.warning ?? null,
    session,
    agent: options.agent,
    compile(source) {
      const result = compileGuide(source, vocabulary);
      return result.ok ? result.program : null;
    },
    // Authored walkthroughs compile against the whole registry, as they do in
    // the app: a cross-route guide names a control on the screen it is about to
    // navigate to, which the route-scoped vocabulary cannot contain.
    compileAuthored(source) {
      const result = compileGuide(
        source,
        {
          goals: guideGoalIds(),
          targets: guideTargetIds(),
          routes: GUIDE_ROUTES.map((route) => route.id),
          predicates: guidePredicateIds(),
        },
        AUTHORED_GUIDE_LIMITS,
      );
      return result.ok ? result.program : null;
    },
    ...tourRunner(runtime, AUTHORED_GUIDE_LIMITS),
    pauseGuide: () => runtime.pause(),
    cancelGuide: (reason) => runtime.cancel(reason),
    subscribeGuide: (listener) => runtime.subscribe({ onSnapshot: listener }),
    async acquire(onProgress) {
      onProgress(0.5);
      options.agent.setAvailability({ kind: "ready" });
      return { kind: "acquired" };
    },
    destroy() {
      torn = true;
      runtime.cancel("lock");
      renderer.clear();
      session.destroy();
    },
    destroyed: () => torn,
  };

  let cleared = 0;
  Object.assign(supportSessionSeams, {
    loadEngine: () => Promise.resolve(engine),
    onLock: (handler: () => void) => {
      lockHandlers.add(handler);
      return () => lockHandlers.delete(handler);
    },
    clearTargets: () => {
      cleared += 1;
    },
  });

  render(
    <MemoryRouter initialEntries={[route]}>
      <SupportProvider>
        <SupportLauncher />
      </SupportProvider>
    </MemoryRouter>,
  );

  return {
    engine,
    fixtures,
    navigations: () => routes.navigations(),
    clearedTargets: () => cleared,
  };
}

/** Every suite's `afterEach`. Order matters: React first, registry last. */
export function disposeSupport(): void {
  cleanup();
  Object.assign(supportSessionSeams, originalSeams);
  lockHandlers.clear();
  liveFixtures?.release();
  liveFixtures = null;
  clearMountedGuideTargets();
  document.body.replaceChildren();
}

/* ---------- shared queries ---------- */

export function launcher(): HTMLElement {
  return screen.getByRole("button", { name: "Support" });
}

export async function openPanel(user: TestUser): Promise<HTMLElement> {
  await user.click(launcher());
  return screen.findByRole("dialog", { name: "Support" });
}

/**
 * Every control the sheet's own focus trap considers reachable — the same
 * query `useModalFocus` runs, so a test asserts on the trap's real membership
 * rather than on a list a reader of the JSX guessed at.
 */
export const TRAPPED =
  'a[href], button:not([disabled]), input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function reachable(container: HTMLElement): readonly HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(TRAPPED)].filter(
    (element) => element.tabIndex >= 0,
  );
}

/** Tabs until `target` holds the caret, proving a keyboard path exists to it. */
export async function tabTo(
  user: TestUser,
  target: HTMLElement,
  limit = 80,
): Promise<void> {
  for (let step = 0; step < limit; step += 1) {
    if (document.activeElement === target) return;
    await user.tab();
  }
  if (document.activeElement !== target) {
    const name = target.getAttribute("aria-label") ?? target.textContent ?? "";
    throw new Error(
      `no keyboard path to "${name.trim()}" within ${limit} tabs`,
    );
  }
}

/** What the statusline mark says while a tutorial is running. */
export const TOURING = "Support — tutorial in progress";

/** The tutorial card, once the first step is drawn. */
export function tutorialCard(): Promise<HTMLElement> {
  return screen.findByRole(
    "dialog",
    { name: /^Tutorial:/ },
    { timeout: 10_000 },
  );
}

/** The "Show me" button beside a named walkthrough or help question. */
export function walkthrough(title: string): HTMLElement {
  const region = screen.getByRole("region", { name: "Questions" });
  const goal = GUIDE_GOALS.find((entry) => entry.title === title);
  const topic = goal
    ? HELP_TOPICS.find((entry) => entry.goal === goal.id)
    : undefined;
  const needles = [title, topic?.title]
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
  const entry = within(region)
    .getAllByRole("article")
    .find((node) => {
      const textContent = (node.textContent ?? "").toLowerCase();
      return needles.some((needle) => textContent.includes(needle));
    });
  if (!entry) throw new Error(`no walkthrough offered for "${title}"`);
  return within(entry).getByRole("button", { name: "Show me" });
}
