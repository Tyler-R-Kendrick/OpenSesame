/** @vitest-environment jsdom */

/**
 * The Tutorials tab: every walkthrough the product has, by what you want to
 * do, each one replayable from its row.
 */

import {
  TUTORIAL_AREAS,
  tutorialLibrary,
} from "@opensesame/app-core/tutorial/registry/areas.js";
import {
  type GuideGoalDescriptor,
  guideGoal,
} from "@opensesame/app-core/tutorial/registry/goals.js";
import { fakeAgentAlwaysUnavailable } from "@opensesame/support-agent";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
import {
  disposeSupport,
  mountSupport,
  openPanel,
  tutorialCard,
} from "../__tests__/a11y/harness.js";
import { filterLibrary } from "./SupportTutorials.js";
import {
  mount,
  openPanel as openSupportPanel,
  resetSupport,
} from "./support-test-harness.js";

function only<T extends HTMLElement>(node: T | null | undefined): T {
  if (!node) throw new Error("the element the test needs is not on the page");
  return node;
}

afterEach(disposeSupport);

async function openLibrary(route = "/vault") {
  const user = userEvent.setup();
  mountSupport({
    agent: fakeAgentAlwaysUnavailable("no_local_model"),
    transport: "none",
    route,
    targets: ["shell.lock"],
  });
  const sheet = await openPanel(user);
  await user.click(within(sheet).getByRole("tab", { name: "Tutorials" }));
  const library = await within(sheet).findByRole("region", {
    name: "Tutorials",
  });
  return { user, sheet, library };
}

describe("the Tutorials tab", () => {
  it("opens on Search when no AI capability is approved, and the tabs are a named, selectable pair", async () => {
    const user = userEvent.setup();
    mountSupport({
      agent: fakeAgentAlwaysUnavailable("no_local_model"),
      transport: "none",
    });
    const sheet = await openPanel(user);
    const tabs = within(sheet).getAllByRole("tab");
    expect(tabs.map((tab) => tab.textContent)).toEqual(["Search", "Tutorials"]);
    expect(tabs[0]?.getAttribute("aria-selected")).toBe("true");
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("false");
    await user.click(only(tabs[1]));
    expect(tabs[1]?.getAttribute("aria-selected")).toBe("true");
  });

  it("lists every tutorial that can start here, grouped, with its length", async () => {
    const { library } = await openLibrary();
    const groups = within(library)
      .getAllByRole("heading", { level: 3 })
      .map((heading) => heading.textContent);
    expect(groups).toContain("Your vault");
    expect(groups).toContain("Keys and unlocking");

    const lock = library.querySelector('[data-tutorial="vault.lock"]');
    expect(lock?.textContent).toContain("Lock the vault");
    expect(lock?.textContent).toContain("2 steps");
    // Every core goal that navigates is offered; each row is a button.
    const offered = library.querySelectorAll("[data-tutorial]").length;
    expect(offered).toBeGreaterThanOrEqual(20);
  });

  it("offers no tutorial for a gate, which has no Support sheet to start one", async () => {
    const { library } = await openLibrary("/vault");
    for (const id of ["unlock.open", "setup.first-run", "broker.authorize"]) {
      expect(library.querySelector(`[data-tutorial="${id}"]`)).toBeNull();
    }
  });

  it("leaves out a tutorial this device has no use for", async () => {
    const { library } = await openLibrary("/vault");
    // No account is signed in, and no install is offered: both tours would
    // point at a control that is not drawn.
    expect(
      library.querySelector('[data-tutorial="identity.sign-out"]'),
    ).toBeNull();
    expect(library.querySelector('[data-tutorial="app.install"]')).toBeNull();
    expect(
      library.querySelector('[data-tutorial="vault.lock"]'),
    ).not.toBeNull();
  });

  it("starts a tutorial from its row, and a second time replays it", async () => {
    const { user, sheet, library } = await openLibrary();
    await user.click(
      only(library.querySelector<HTMLElement>('[data-tutorial="vault.lock"]')),
    );
    const card = await tutorialCard();
    expect(card.textContent).toContain("Step 1 of 2");
    // The sheet stepped aside for it.
    await waitFor(() => expect(sheet.isConnected).toBe(false));

    await user.click(
      within(card).getByRole("button", { name: "Exit tutorial" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /^Tutorial:/ })).toBeNull(),
    );

    await user.click(await screen.findByRole("button", { name: "Support" }));
    const again = await screen.findByRole("dialog", { name: "Support" });
    await user.click(within(again).getByRole("tab", { name: "Tutorials" }));
    await user.click(
      only(again.querySelector<HTMLElement>('[data-tutorial="vault.lock"]')),
    );
    expect((await tutorialCard()).textContent).toContain("Step 1 of 2");
  });
});

describe("filtering the library", () => {
  const goal = (id: string, title: string): GuideGoalDescriptor => ({
    id,
    title,
    routes: [],
    guide: "",
  });
  const groups = [
    {
      id: "vault",
      title: "Your vault",
      tutorials: [
        { goal: goal("a.b", "Lock the vault"), steps: 2 },
        { goal: goal("c.d", "Export the vault"), steps: 1 },
      ],
    },
    {
      id: "access",
      title: "Access",
      tutorials: [{ goal: goal("e.f", "Grant an agent access"), steps: 3 }],
    },
  ];

  it("keeps everything for a blank query", () => {
    expect(filterLibrary(groups, "  ")).toBe(groups);
  });

  it("narrows by title, and by the group a tutorial sits in", () => {
    expect(
      filterLibrary(groups, "export").flatMap((group) =>
        group.tutorials.map((entry) => entry.goal.id),
      ),
    ).toEqual(["c.d"]);
    expect(
      filterLibrary(groups, "access").flatMap((group) =>
        group.tutorials.map((entry) => entry.goal.id),
      ),
    ).toEqual(["e.f"]);
    expect(filterLibrary(groups, "zebra")).toEqual([]);
  });

  it("only ever lists goals the product has, each placed in an area", () => {
    const placed = new Set(TUTORIAL_AREAS.flatMap((area) => area.goals));
    const rows = tutorialLibrary("/vault").flatMap((group) =>
      group.tutorials.map((entry) => entry.goal.id),
    );
    expect(rows.length).toBeGreaterThan(0);
    for (const id of rows) {
      expect(guideGoal(id)?.id).toBe(id);
      expect(placed.has(id)).toBe(true);
    }
  });
});

describe("a walkthrough offered beside an answer", () => {
  afterEach(resetSupport);

  it("launches a named walkthrough with no model at all", async () => {
    const user = userEvent.setup();
    const { engine: built } = mount(
      fakeAgentAlwaysUnavailable("no_local_model"),
      "none",
    );
    await openSupportPanel(user);
    expect(
      (await screen.findByRole("region", { name: "Questions" })).textContent,
    ).toContain("Where do I lock the vault?");
    await user.click(
      only(screen.getAllByRole("button", { name: "Show me" })[0]),
    );

    // The sheet steps aside; the tutorial opens on a sentence, then lights the lock.
    const card = await screen.findByRole("dialog", { name: /^Tutorial:/ });
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: "Support" })).toBeNull(),
    );
    await user.click(within(card).getByRole("button", { name: /^Next/ }));
    await waitFor(() =>
      expect(
        built.renderer.calls.some(
          (call) => call.kind === "focus" && call.target === "shell.lock",
        ),
      ).toBe(true),
    );
    // The mark says one is live; the exit key stops it.
    const live = "Support — tutorial in progress";
    await screen.findByRole("button", { name: live });
    await user.click(
      within(card).getByRole("button", { name: "Exit tutorial" }),
    );
    await waitFor(() =>
      expect(screen.queryByRole("button", { name: live })).toBeNull(),
    );
  });
});
