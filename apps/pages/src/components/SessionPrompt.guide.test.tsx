/** @vitest-environment jsdom */
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import {
  guideGoal,
  guideGoalIds,
} from "@opensesame/app-core/tutorial/registry/goals.js";
import {
  provideGuideDeviceForm,
  registerGuidePredicates,
} from "@opensesame/app-core/tutorial/registry/predicates.js";
import { mergedGuideRoutes } from "@opensesame/app-core/tutorial/registry/routes.js";
import { guidePredicateIds } from "@opensesame/app-core/tutorial/registry/state.js";
import {
  guideTargetIds,
  resolveGuideTargetElement,
} from "@opensesame/app-core/tutorial/registry/targets.js";
import { AUTHORED_GUIDE_LIMITS, compileGuide } from "@opensesame/guide-lang";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter } from "react-router";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { FakeMediaQueryList } from "../lib/use-narrow.test-fake.js";
import {
  SupportProvider,
  loadBrowserEngine,
  supportSessionSeams,
  useSupport,
} from "../tutorial/session.js";
import { MobileToolbar } from "./MobileToolbar.js";
import { NavDrawer } from "./NavDrawer.js";
import { SessionPrompt } from "./SessionPrompt.js";

beforeAll(registerGuidePredicates);
const originalSessionSeams = { ...supportSessionSeams };
const goals = [
  ["vaults.switch", "prompt.tomb"],
  ["identity.sign-in", "shell.account"],
  ["identity.sign-out", "shell.account"],
  ["identity.switch-account", "shell.account"],
] as const;
afterEach(() => {
  cleanup();
  Object.assign(supportSessionSeams, originalSessionSeams);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  provideGuideDeviceForm(() => ({ narrow: false, keys: true }));
});

function TourControls({ id }: { id: string }) {
  const { support, view } = useSupport();
  const tour = view.guide?.tour;
  return (
    <>
      <button
        type="button"
        onClick={() => {
          const goal = guideGoal(id);
          if (!goal) throw new Error("missing session walkthrough");
          void support.startGuide(goal.guide, "authored");
        }}
      >
        Start tutorial
      </button>
      <button type="button" onClick={() => support.nextStep()}>
        Next
      </button>
      <output data-target={tour?.target} data-degraded={tour?.degraded}>
        {tour?.kind === "close" ? "Complete" : tour?.step}
      </output>
    </>
  );
}

describe("Next-only session tutorials", () => {
  it.each(goals)(
    "reveals %s's %s through the real runtime",
    async (id, target) => {
      const user = userEvent.setup();
      provideGuideDeviceForm(() => ({ narrow: true, keys: false }));
      vi.stubGlobal(
        "matchMedia",
        (query: string) =>
          new FakeMediaQueryList(query, query === "(max-width: 900px)"),
      );
      vi.spyOn(vaultStore, "getSnapshot").mockReturnValue({
        ...vaultStore.getSnapshot(),
        status: "unlocked",
      });
      Object.assign(supportSessionSeams, {
        loadEngine: (host: Parameters<typeof loadBrowserEngine>[0]) =>
          loadBrowserEngine(host, { offline: true }),
      });
      render(
        <MemoryRouter>
          <SupportProvider>
            <MobileToolbar />
            <TourControls id={id} />
          </SupportProvider>
        </MemoryRouter>,
      );
      await user.click(screen.getByRole("button", { name: "Start tutorial" }));
      const output = document.querySelector("output");
      if (!output) throw new Error("missing runtime snapshot");
      await waitFor(() => expect(output.textContent).toBe("1"));
      expect(resolveGuideTargetElement(target)).toBeNull();
      const next = screen.getByRole("button", { name: "Next" });
      for (const step of [2, 3]) {
        await user.click(next);
        await waitFor(() => expect(output.textContent).toBe(String(step)));
      }
      await waitFor(() => {
        expect(output.getAttribute("data-target")).toBe(target);
        expect(output.getAttribute("data-degraded")).toBe("false");
        expect(
          resolveGuideTargetElement(target)?.closest(".drawer"),
        ).toBeTruthy();
      });
      expect(document.activeElement).toBe(next);
      await user.keyboard("{Enter}");
      await waitFor(() =>
        expect(screen.queryByRole("dialog", { name: "Sections" })).toBeNull(),
      );
    },
  );
});

function pointers(source: string) {
  const compiled = compileGuide(
    source,
    {
      goals: guideGoalIds(),
      targets: guideTargetIds(),
      routes: mergedGuideRoutes().map((route) => route.id),
      predicates: guidePredicateIds(),
    },
    AUTHORED_GUIDE_LIMITS,
  );
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.errors));
  return compiled.program.instructions
    .filter((step) => step.kind === "focus")
    .map((step) => step.target);
}

describe("session walkthroughs after consolidating phone controls", () => {
  it.each(goals)("reveals the drawer before %s points at %s", (id, target) => {
    const goal = guideGoal(id);
    if (!goal) throw new Error("missing session walkthrough");
    provideGuideDeviceForm(() => ({ narrow: true, keys: false }));
    render(
      <MemoryRouter>
        <div style={{ display: "none" }}>
          <SessionPrompt />
        </div>
        <NavDrawer session={<SessionPrompt showLock={false} />} />
      </MemoryRouter>,
    );
    expect(pointers(goal.guide)).toEqual(["nav.menu", target]);
    expect(goal.guide).toContain(
      'wait target "nav.menu" event=activate timeout=30000',
    );
    expect(resolveGuideTargetElement(target)).toBeNull();
    expect(resolveGuideTargetElement("nav.menu")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Sections" }));
    expect(resolveGuideTargetElement(target)?.closest(".drawer")).toBeTruthy();
  });

  it.each(goals)(
    "keeps %s direct when the phone drawer is already open",
    (id, target) => {
      const goal = guideGoal(id);
      if (!goal) throw new Error("missing session walkthrough");
      provideGuideDeviceForm(() => ({ narrow: true, keys: false }));
      render(
        <MemoryRouter>
          <div style={{ display: "none" }}>
            <SessionPrompt />
          </div>
          <NavDrawer session={<SessionPrompt showLock={false} />} />
        </MemoryRouter>,
      );
      fireEvent.click(screen.getByRole("button", { name: "Sections" }));
      expect(
        resolveGuideTargetElement(target)?.closest(".drawer"),
      ).toBeTruthy();
      expect(pointers(goal.guide)).toEqual([target]);
      expect(goal.guide).not.toContain('wait target "nav.menu"');
    },
  );

  it.each(goals)(
    "keeps %s direct on desktop after reading the phone guide",
    (id, target) => {
      const goal = guideGoal(id);
      if (!goal) throw new Error("missing session walkthrough");
      provideGuideDeviceForm(() => ({ narrow: true, keys: false }));
      expect(pointers(goal.guide)).toEqual(["nav.menu", target]);
      provideGuideDeviceForm(() => ({ narrow: false, keys: true }));
      render(
        <MemoryRouter>
          <SessionPrompt />
        </MemoryRouter>,
      );
      expect(pointers(goal.guide)).toEqual([target]);
      expect(resolveGuideTargetElement(target)).not.toBeNull();
    },
  );
});
