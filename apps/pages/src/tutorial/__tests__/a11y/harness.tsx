/**
 * The substrate the accessibility suites in this directory drive.
 *
 * It differs from `ui/support.test.tsx` in one deliberate way: the guide
 * renderer here is the *real* Driver.js adapter over a stand-in for Driver
 * itself, rather than the recording renderer. Accessibility questions about a
 * walkthrough — who holds the caret, whether a callout is a dialog, whether
 * anything animates — are questions about what the adapter puts in the
 * document, and a renderer that only records calls cannot answer them.
 *
 * The stand-in reproduces the two Driver behaviours that matter: both popover
 * slots are written as `innerHTML` before the render hook runs, and Driver
 * moves focus into its own popover. A fake that did neither would let the
 * panel pass on a page the real library would break.
 */
import { guideGoalIds } from "../../registry/goals.js";
import { GUIDE_ROUTES } from "../../registry/routes.js";
import { guidePredicateIds } from "../../registry/state.js";
import { guideTargetIds } from "../../registry/targets.js";

import { compileGuide } from "@opensesame/guide-lang";
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
import { buildSupportPageContext } from "../../registry/context.js";
import {
  clearMountedGuideTargets,
  mountGuideTarget,
  resolveGuideTargetElement,
} from "../../registry/targets.js";
import type {
  GuideDriverConfig,
  GuideDriverFactory,
  GuideDriverStep,
  GuideHintSpec,
  GuideHintsConfig,
  GuideHintsFactory,
} from "../../rendering/driver-renderer.js";
import { createDriverRenderer } from "../../rendering/driver-renderer.js";
import type { SupportEngine, SupportTransport } from "../../session.js";
import { SupportProvider, supportSessionSeams } from "../../session.js";
import { SupportLauncher } from "../../ui/SupportLauncher.js";

export type TestUser = ReturnType<typeof userEvent.setup>;

/* ---------- the Driver.js stand-in ---------- */

export type DriverRecord = {
  readonly config: GuideDriverConfig;
  readonly steps: readonly GuideDriverStep[];
  readonly popovers: readonly HTMLElement[];
};

export type DriverProbe = {
  readonly factory: GuideDriverFactory;
  records(): readonly DriverRecord[];
  /** Every popover still attached to the document. */
  popovers(): readonly HTMLElement[];
};

function createDriverProbe(): DriverProbe {
  const records: DriverRecord[] = [];
  const factory: GuideDriverFactory = (config) => {
    const steps: GuideDriverStep[] = [];
    const popovers: HTMLElement[] = [];
    records.push({ config, steps, popovers });
    return {
      highlight: (step) => {
        steps.push(step);
        const wrapper = document.createElement("div");
        wrapper.className = `driver-popover ${step.popover.popoverClass}`;
        wrapper.setAttribute("role", "dialog");
        wrapper.setAttribute("aria-labelledby", "driver-popover-title");
        const title = document.createElement("header");
        title.className = "driver-popover-title";
        const description = document.createElement("div");
        description.className = "driver-popover-description";
        const dismiss = document.createElement("button");
        dismiss.type = "button";
        dismiss.className = "driver-popover-close-btn";
        dismiss.textContent = "×";
        wrapper.append(title, description, dismiss);
        document.body.appendChild(wrapper);
        title.innerHTML = step.popover.description;
        description.innerHTML = step.popover.description;
        step.popover.onPopoverRender({ wrapper, title, description });
        popovers.push(wrapper);
        // Driver.js focuses the first focusable node in its own popover. The
        // adapter is supposed to take the caret straight back off it.
        dismiss.focus();
        config.onHighlighted();
      },
      destroy: () => {
        for (const popover of popovers) popover.remove();
      },
    };
  };
  return {
    factory,
    records: () => [...records],
    popovers: () =>
      records.flatMap((record) =>
        record.popovers.filter((node) => node.isConnected),
      ),
  };
}

export type HintRecord = {
  readonly config: GuideHintsConfig;
};

export type HintsProbe = {
  readonly factory: GuideHintsFactory;
  records(): readonly HintRecord[];
};

function createHintsProbe(): HintsProbe {
  const records: HintRecord[] = [];
  const factory: GuideHintsFactory = (config) => {
    const nodes: HTMLElement[] = [];
    records.push({ config });
    const beaconFor = (spec: GuideHintSpec): HTMLElement => {
      const beacon = document.createElement("button");
      beacon.type = "button";
      beacon.className = `driver-hint ${spec.beacon.className}`;
      document.body.appendChild(beacon);
      nodes.push(beacon);
      return beacon;
    };
    return {
      show: () => {
        for (const spec of config.hints) beaconFor(spec);
      },
      open: (id) => {
        const spec = config.hints.find((candidate) => candidate.id === id);
        if (!spec) return;
        const wrapper = document.createElement("div");
        wrapper.className = `driver-popover ${spec.popover.popoverClass}`;
        const title = document.createElement("header");
        const description = document.createElement("div");
        description.className = "driver-popover-description";
        wrapper.append(title, description);
        document.body.appendChild(wrapper);
        description.innerHTML = spec.popover.description;
        spec.popover.onPopoverRender({ wrapper, title, description });
        nodes.push(wrapper);
        // Driver's hint beacon takes the caret; the adapter puts it back.
        const first = nodes[0];
        if (first) first.focus();
      },
      hide: () => {
        for (const node of nodes) node.remove();
        nodes.length = 0;
      },
    };
  };
  return { factory, records: () => [...records] };
}

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
  readonly driver: DriverProbe;
  readonly hints: HintsProbe;
  readonly fixtures: TargetFixtures;
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
  const driver = createDriverProbe();
  const hints = createHintsProbe();
  const fixtures = mountFixtures(options.targets ?? []);
  liveFixtures = fixtures;
  const renderer = createDriverRenderer({
    resolveElement: resolveGuideTargetElement,
    reducedMotion: () => options.reducedMotion ?? false,
    driverFactory: driver.factory,
    hintsFactory: hints.factory,
  });
  const targets = createFakeTargets(vocabulary.targets, vocabulary.targets);
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
      const result = compileGuide(source, {
        goals: guideGoalIds(),
        targets: guideTargetIds(),
        routes: GUIDE_ROUTES.map((route) => route.id),
        predicates: guidePredicateIds(),
      });
      return result.ok ? result.program : null;
    },
    runGuide: (program) => runtime.start(program),
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
    driver,
    hints,
    fixtures,
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

/** The "Show me" button beside a named walkthrough. */
export function walkthrough(title: string): HTMLElement {
  const region = screen.getByRole("region", { name: "Walkthroughs" });
  const entry = within(region)
    .getAllByRole("article")
    .find((node) => (node.textContent ?? "").startsWith(title));
  if (!entry) throw new Error(`no walkthrough offered for "${title}"`);
  return within(entry).getByRole("button", { name: "Show me" });
}
