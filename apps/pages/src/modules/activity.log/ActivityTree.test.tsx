import * as activityLog from "@opensesame/app-core/lib/activity-log.js";
import type { ActivityEvent } from "@opensesame/app-core/lib/activity-log.js";
import { defaultPrefs } from "@opensesame/app-core/lib/vault/prefs.js";
import type { VaultState } from "@opensesame/app-core/lib/vault/store.js";
/** @vitest-environment jsdom */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { setRailCursor } from "../../components/rail-cursor.js";
import { LISTING_PAGE_SIZE } from "../../lib/listing-page.js";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { ActivitySection } from "../../sections/ActivitySection.js";
import { resetActivityListing } from "../../sections/activity/activity-listing.js";
import { ActivityTree } from "./ActivityTree.js";

const originalVault = vaultHooksSeams.useVault;

function unlocked(): VaultState {
  return {
    status: "unlocked",
    tomb: "personal",
    guest: false,
    header: null,
    items: [],
    folders: [],
    prefs: defaultPrefs,
    lockedOutUntil: null,
    failedAttempts: 0,
    awaitingSecondStep: false,
    durable: true,
  };
}

/** 30 events, newest first; every third is a settings change. */
const EVENTS: ActivityEvent[] = Array.from({ length: 30 }, (_, index) => {
  const settings = index % 3 === 0;
  return {
    id: `event-${index}`,
    occurredAt: new Date(Date.UTC(2026, 8, 1, 10, 0, 30 - index)).toISOString(),
    category: settings ? "settings" : "vault",
    type: settings ? "settings.updated" : "vault.unlocked",
    summary: `${settings ? "Settings updated" : "Vault unlocked"} ${String(index).padStart(2, "0")}`,
    outcome: "info",
    targetType: null,
    targetId: null,
    metadata: {},
  };
});

beforeEach(() => {
  vaultHooksSeams.useVault = unlocked;
  vi.spyOn(activityLog, "listActivityEvents").mockResolvedValue(EVENTS);
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vaultHooksSeams.useVault = originalVault;
  resetActivityListing();
  setRailCursor(null);
});

/** Stands in for a link followed from elsewhere in the app. */
function FollowLink() {
  const navigate = useNavigate();
  return (
    <button
      type="button"
      onClick={() => navigate("/activity#activity-event-1")}
    >
      Follow link
    </button>
  );
}

function renderActivity(path = "/activity") {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <FollowLink />
      <nav aria-label="Rail">
        <div role="tree">
          <ActivityTree pathname="/activity" />
        </div>
      </nav>
      <main>
        <ActivitySection />
      </main>
    </MemoryRouter>,
  );
}

function railLeaves(): string[] {
  const rail = screen.getByRole("navigation", { name: "Rail" });
  return within(rail)
    .getAllByRole("treeitem")
    .map((row) => row.getAttribute("aria-label") ?? row.textContent ?? "");
}

function pageRows(): HTMLElement[] {
  return within(screen.getByRole("main")).queryAllByRole("listitem");
}

it("lists the first page under the rail row and loads n more, like every subtree", async () => {
  renderActivity();
  await waitFor(() => expect(pageRows()).toHaveLength(LISTING_PAGE_SIZE));
  expect(railLeaves()).toHaveLength(LISTING_PAGE_SIZE + 1);
  expect(railLeaves().at(-1)).toBe("Load 12 more");
  expect(railLeaves()[0]).toBe("Settings updated 00");

  const rail = screen.getByRole("navigation", { name: "Rail" });
  fireEvent.click(within(rail).getByRole("treeitem", { name: "Load 12 more" }));
  expect(railLeaves()).toHaveLength(24 + 1);
  expect(pageRows()).toHaveLength(24);

  // The page's key advances the same listing.
  fireEvent.click(screen.getByRole("button", { name: "Load 6 more" }));
  await waitFor(() => expect(pageRows()).toHaveLength(30));
  expect(railLeaves()).toHaveLength(30);
  expect(screen.queryByRole("button", { name: /Load .* more/ })).toBeNull();
});

it("searches the log with /, narrowing the rail with the page", async () => {
  renderActivity();
  await waitFor(() => expect(pageRows()).toHaveLength(LISTING_PAGE_SIZE));

  fireEvent.click(screen.getByRole("button", { name: "Search activity" }));
  const field = screen.getByRole("textbox", {
    name: "Search the activity log",
  });
  fireEvent.change(field, { target: { value: "settings" } });

  await waitFor(() => expect(pageRows()).toHaveLength(10));
  expect(railLeaves()).toHaveLength(10);
  expect(railLeaves().every((label) => label.startsWith("Settings"))).toBe(
    true,
  );

  fireEvent.change(field, { target: { value: "no such event" } });
  await waitFor(() =>
    expect(
      within(screen.getByRole("main")).getByText("No matching activity"),
    ).toBeTruthy(),
  );
  expect(
    within(screen.getByRole("navigation", { name: "Rail" })).getByText(
      "No matching activity",
    ),
  ).toBeTruthy();

  fireEvent.click(screen.getByRole("button", { name: "Clear search" }));
  await waitFor(() => expect(pageRows()).toHaveLength(LISTING_PAGE_SIZE));
  expect(
    screen.queryByRole("textbox", { name: "Search the activity log" }),
  ).toBeNull();
});

it("a deep link past the first page grows the listing to its row", async () => {
  renderActivity("/activity#activity-event-28");
  await waitFor(() => expect(pageRows()).toHaveLength(30));
  expect(document.getElementById("activity-event-28")).not.toBeNull();
  const rail = screen.getByRole("navigation", { name: "Rail" });
  const row = within(rail).getByRole("treeitem", {
    name: "Vault unlocked 28",
  });
  expect(row.getAttribute("aria-selected")).toBe("true");
});

it("a search typed on a selected row narrows the list and keeps the prompt", async () => {
  renderActivity("/activity#activity-event-1");
  await waitFor(() => expect(pageRows()).toHaveLength(LISTING_PAGE_SIZE));
  fireEvent.click(screen.getByRole("button", { name: "Search activity" }));
  const field = screen.getByRole("textbox", {
    name: "Search the activity log",
  });
  // event-1 is a vault event: "settings" hides it.
  fireEvent.change(field, { target: { value: "settings" } });
  await waitFor(() => expect(pageRows()).toHaveLength(10));
  expect(screen.getByRole("textbox", { name: "Search the activity log" })).toBe(
    field,
  );
});

it("a link to a row the search hides clears the search", async () => {
  renderActivity();
  await waitFor(() => expect(pageRows()).toHaveLength(LISTING_PAGE_SIZE));
  fireEvent.click(screen.getByRole("button", { name: "Search activity" }));
  fireEvent.change(
    screen.getByRole("textbox", { name: "Search the activity log" }),
    { target: { value: "settings" } },
  );
  await waitFor(() => expect(pageRows()).toHaveLength(10));
  // A link to a vault event arrives while the search hides it.
  fireEvent.click(screen.getByRole("button", { name: "Follow link" }));
  await waitFor(() =>
    expect(
      screen.queryByRole("textbox", { name: "Search the activity log" }),
    ).toBeNull(),
  );
  expect(pageRows()).toHaveLength(LISTING_PAGE_SIZE);
  expect(document.getElementById("activity-event-1")).not.toBeNull();
});

it("says so while locked, without reading the log", async () => {
  vaultHooksSeams.useVault = () => ({ ...unlocked(), status: "locked" });
  render(
    <MemoryRouter initialEntries={["/activity"]}>
      <ActivityTree pathname="/activity" />
    </MemoryRouter>,
  );
  expect(screen.getByText("Locked")).toBeTruthy();
  expect(activityLog.listActivityEvents).not.toHaveBeenCalled();
});
