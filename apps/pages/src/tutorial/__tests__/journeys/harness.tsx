/**
 * The application these journeys are walked through.
 *
 * Everything a person touches here is the real thing: the shell they navigate
 * with, the semantic target registry the rail and the tab bar bind themselves
 * to, the compiler a program is checked by, the runtime that drives it, the
 * support session that holds the conversation, and the panel it is read in.
 * Only two things are substituted, because neither can be driven
 * deterministically — the model, which is a scripted fake agent, and the
 * deadline clock, which never fires unless a test advances it.
 *
 * The renderer is the recording one rather than Driver.js: these stories are
 * about *what* a walkthrough was asked to point at and when, and the overlay
 * Driver.js actually draws already has its own suite.
 *
 * The shell's identity, connectivity and breadcrumb widgets are stood down
 * through their own seams. They reach for storage and the network, none of
 * them is part of a support journey, and leaving them in would make every
 * story below a test of them as well.
 */
import { guideGoalIds } from "../../registry/goals.js";
import { GUIDE_ROUTES } from "../../registry/routes.js";
import { guidePredicateIds } from "../../registry/state.js";
import { guideTargetIds } from "../../registry/targets.js";

import { compileGuide } from "@opensesame/guide-lang";
import type {
  GuideOutcome,
  RecordedRendererCall,
  RecordingGuideRenderer,
  TestGuideClock,
} from "@opensesame/guide-runtime";
import {
  createGuideRuntime,
  createRecordingRenderer,
  createTestClock,
} from "@opensesame/guide-runtime";
import type {
  FakeSupportAgent,
  SupportGuideVocabulary,
  SupportPageContext,
} from "@opensesame/support-agent";
import { createSupportSession } from "@opensesame/support-agent";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes } from "react-router";
import { expect } from "vitest";
import { accountSwitcherSeams } from "../../../components/AccountSwitcher.js";
import { AppShell } from "../../../components/AppShell.js";
import { connectivityBarSeams } from "../../../components/ConnectivityBar.js";
import { crumbsSeams } from "../../../components/Crumbs.js";
import { notificationsBarSeams } from "../../../components/NotificationsBar.js";
import { projectSwitcherSeams } from "../../../components/ProjectSwitcher.js";
import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
import { CatalogPanel } from "../../../sections/connections/CatalogPanel.js";
import { HealthPanel } from "../../../sections/vault/HealthPanel.js";
import { buildSupportPageContext } from "../../registry/context.js";
import { registerGuidePredicates } from "../../registry/predicates.js";
import { isKnownGuideRoute } from "../../registry/routes.js";
import {
  isKnownGuidePredicate,
  observeGuidePredicate,
  readGuidePredicate,
} from "../../registry/state.js";
import {
  clearMountedGuideTargets,
  isKnownGuideTarget,
  isMountedGuideTarget,
  observeGuideTarget,
} from "../../registry/targets.js";
import {
  type SupportEngine,
  type SupportHost,
  SupportProvider,
  type SupportTransport,
  supportSessionSeams,
} from "../../session.js";
import {
  SupportLauncher,
  SupportSlotProvider,
} from "../../ui/SupportLauncher.js";

export type JourneyUser = ReturnType<typeof userEvent.setup>;

const lockHandlers = new Set<() => void>();
let lockPresses = 0;
let targetsCleared = 0;

/**
 * The vault locks. However it was asked for — the statusline button, the idle
 * timer, another tab — support only ever hears the event.
 */
export function lockTheVault(): void {
  for (const handler of [...lockHandlers]) handler();
}

/** The statusline lock, as the shell reaches it through the vault store. */
function pressLock(): void {
  lockPresses += 1;
  lockTheVault();
}

Object.assign(vaultHooksSeams, {
  useVault: () => ({
    items: [],
    folders: [],
    header: null,
    status: "unlocked",
  }),
  useVaultStore: () => ({ lock: pressLock }),
});
Object.assign(connectivityBarSeams, {
  ConnectivityBar: () => <span>Host and Identity</span>,
});
Object.assign(notificationsBarSeams, {
  NotificationsBar: () => <span>Notices</span>,
});
Object.assign(accountSwitcherSeams, {
  AccountSwitcher: () => <span>guest</span>,
});
Object.assign(projectSwitcherSeams, {
  ProjectSwitcher: () => <span>personal</span>,
});
Object.assign(crumbsSeams, {
  Crumbs: () => <nav aria-label="Breadcrumb" />,
});

/**
 * The screens a journey can reach. Connections and Vault health are the real
 * ones, because their controls are what a walkthrough points at once the
 * person has arrived; the vault list stands in, since no journey below
 * highlights anything inside it.
 */
function Screens() {
  return (
    <Routes>
      <Route path="/connections" element={<CatalogPanel providers={[]} />} />
      <Route path="/vault/health" element={<HealthPanel />} />
      <Route path="*" element={<p>Everything this deployment holds.</p>} />
    </Routes>
  );
}

type JourneyEngine = SupportEngine & {
  readonly renderer: RecordingGuideRenderer;
  readonly clock: TestGuideClock;
  /** Trajectories that have settled, in the order they settled. */
  outcomes(): readonly GuideOutcome[];
  /** Routes the guide asked the app to visit. A person's own clicks are not here. */
  navigations(): readonly string[];
  destroyed(): boolean;
};

/**
 * The engine `session.ts` builds in a browser, with the model and the clock
 * replaced. The vocabulary is read through on every compile rather than
 * snapshotted, exactly as `loadBrowserEngine` reads it: a replan has to be
 * checked against the page the person actually reached.
 */
function buildEngine(
  agent: FakeSupportAgent,
  host: SupportHost,
  transport: SupportTransport,
): JourneyEngine {
  registerGuidePredicates();
  const readContext = (question?: string): SupportPageContext => {
    const input = {
      pageId: "pages",
      route: host.currentRoute(),
      hostReachable: true,
      identityReachable: true,
    };
    if (question === undefined) return buildSupportPageContext(input);
    return buildSupportPageContext({ ...input, question });
  };
  const vocabulary: SupportGuideVocabulary = {
    get goals() {
      return readContext().goals.map((goal) => goal.id);
    },
    get targets() {
      return readContext().targets.map((target) => target.id);
    },
    get routes() {
      return readContext().routes.map((route) => route.id);
    },
    get predicates() {
      return readContext().state.map((fact) => fact.id);
    },
  };
  const session = createSupportSession({
    port: agent,
    vocabulary,
    readContext,
  });
  const renderer = createRecordingRenderer();
  const clock = createTestClock();
  const navigations: string[] = [];
  const outcomes: GuideOutcome[] = [];
  const runtime = createGuideRuntime({
    renderer,
    targets: {
      isKnown: isKnownGuideTarget,
      isMounted: isMountedGuideTarget,
      observe: observeGuideTarget,
    },
    routes: {
      current: host.currentRoute,
      isKnown: isKnownGuideRoute,
      navigate: (route) => {
        navigations.push(route);
        host.navigate(route);
      },
      observe: host.observeRoute,
    },
    state: {
      isKnown: isKnownGuidePredicate,
      read: readGuidePredicate,
      observe: observeGuidePredicate,
    },
    clock,
  });
  let destroyed = false;

  return {
    transport,
    // No journey below is answered off the device, so there is no egress
    // sentence to carry; `ui/support.test.tsx` owns that one.
    warning: null,
    session,
    renderer,
    clock,
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
    async runGuide(program) {
      const outcome = await runtime.start(program);
      outcomes.push(outcome);
      return outcome;
    },
    pauseGuide: () => runtime.pause(),
    cancelGuide: (reason) => runtime.cancel(reason),
    subscribeGuide: (listener) => runtime.subscribe({ onSnapshot: listener }),
    async acquire(onProgress) {
      onProgress(1);
      agent.setAvailability({ kind: "ready" });
      return { kind: "acquired" };
    },
    destroy() {
      destroyed = true;
      runtime.cancel("lock");
      renderer.clear();
      session.destroy();
    },
    outcomes: () => [...outcomes],
    navigations: () => [...navigations],
    destroyed: () => destroyed,
  };
}

export type JourneyOptions = {
  /** Where the person is when the story starts. */
  readonly at?: string;
  readonly transport?: SupportTransport;
};

export type Journey = {
  readonly user: JourneyUser;
  /** Everything the guide renderer was asked to draw, in order. */
  drawn(): readonly RecordedRendererCall[];
  /** Just the controls a walkthrough highlighted, in order. */
  focused(): readonly string[];
  outcomes(): readonly GuideOutcome[];
  navigations(): readonly string[];
  /** Presses of the statusline lock, by whoever made them. */
  lockPresses(): number;
  targetsCleared(): number;
  engineDestroyed(): boolean;
  agentDestroyed(): boolean;
};

const originalSeams = { ...supportSessionSeams };
let built: JourneyEngine | null = null;

export function renderJourney(
  agent: FakeSupportAgent,
  options: JourneyOptions = {},
): Journey {
  const transport = options.transport ?? "on-device";
  Object.assign(supportSessionSeams, {
    loadEngine: (host: SupportHost) => {
      const engine = buildEngine(agent, host, transport);
      built = engine;
      return Promise.resolve(engine);
    },
    onLock: (handler: () => void) => {
      lockHandlers.add(handler);
      return () => {
        lockHandlers.delete(handler);
      };
    },
    clearTargets: () => {
      targetsCleared += 1;
      clearMountedGuideTargets();
    },
  });
  const user = userEvent.setup();
  render(
    <MemoryRouter initialEntries={[options.at ?? "/vault"]}>
      <SupportProvider>
        <SupportSlotProvider>
          <AppShell>
            <Screens />
          </AppShell>
          <SupportLauncher />
        </SupportSlotProvider>
      </SupportProvider>
    </MemoryRouter>,
  );

  const drawn = (): readonly RecordedRendererCall[] =>
    built?.renderer.calls ?? [];
  return {
    user,
    drawn,
    focused: () =>
      drawn().flatMap((call) => (call.kind === "focus" ? [call.target] : [])),
    outcomes: () => built?.outcomes() ?? [],
    navigations: () => built?.navigations() ?? [],
    lockPresses: () => lockPresses,
    targetsCleared: () => targetsCleared,
    engineDestroyed: () => built?.destroyed() ?? false,
    agentDestroyed: () => agent.destroyed(),
  };
}

export function resetJourney(): void {
  cleanup();
  clearMountedGuideTargets();
  Object.assign(supportSessionSeams, originalSeams);
  lockHandlers.clear();
  built = null;
  lockPresses = 0;
  targetsCleared = 0;
}

/** The overlay affordance, which is present at every width. */
export async function openSupport(user: JourneyUser): Promise<HTMLElement> {
  await user.click(screen.getByRole("button", { name: "Support" }));
  return screen.findByRole("dialog", { name: "Support" });
}

/**
 * The way back in while a walkthrough is live. The panel steps aside for one,
 * and the overlay is what says so.
 */
export async function reopenSupport(user: JourneyUser): Promise<HTMLElement> {
  await user.click(
    await screen.findByRole("button", {
      name: "Support — walkthrough in progress",
    }),
  );
  return screen.findByRole("dialog", { name: "Support" });
}

export async function askSupport(
  user: JourneyUser,
  question: string,
): Promise<void> {
  const field = await screen.findByLabelText<HTMLInputElement>(
    "Ask about this screen",
  );
  await waitFor(() => expect(field.disabled).toBe(false));
  await user.type(field, question);
  await user.click(screen.getByRole("button", { name: "Ask" }));
}

/** Counts clicks on one element, so "nothing activated it" can be asserted. */
export function countClicks(element: HTMLElement): () => number {
  let clicks = 0;
  element.addEventListener("click", () => {
    clicks += 1;
  });
  return () => clicks;
}
