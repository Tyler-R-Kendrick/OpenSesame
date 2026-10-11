/** @vitest-environment jsdom */
import { clearNotices } from "@opensesame/app-core/lib/notices.js";
import {
  Clock,
  armedCircle,
  device,
  who,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { GuardingPanel } from "../GuardingPanel.js";
import {
  declareTargets,
  elementById,
  serveDesk,
} from "../trusted-contacts.test-support.js";
import type { Desk } from "../use-desk.js";
import {
  captureCopies,
  liveDesk,
  restoreCopies,
} from "./guarding.test-support.js";

let undeclare: () => void;
let unserve: () => void = () => undefined;

beforeEach(() => {
  undeclare = declareTargets();
  captureCopies();
});

afterEach(() => {
  cleanup();
  unserve();
  undeclare();
  clearNotices();
  restoreCopies();
});

function serve(desk: Desk) {
  unserve();
  unserve = serveDesk(desk);
}

const HEAD = [
  ["guarding-accept", "Accept an invitation", "guarding.accept"],
  ["guarding-take", "Take what an owner sent", "guarding.take"],
  ["guarding-answer", "Answer a request", "guarding.answer"],
] as const;

describe("the Guarding panel's head", () => {
  it("carries three keys, each a target the walkthrough points at", async () => {
    serve(await liveDesk(device(new Clock())));
    render(<GuardingPanel />);
    const group = screen.getByRole("group", { name: "Guarding commands" });
    const keys = within(group).getAllByRole("button");
    expect(keys.map((key) => key.getAttribute("aria-label"))).toEqual(
      HEAD.map(([, label]) => label),
    );
    for (const [id, label, target] of HEAD) {
      const key = elementById(id);
      expect(key.getAttribute("title")).toBe(label);
      expect(key.getAttribute("data-guide-targets")).toContain(target);
    }
    // Nothing is held yet: an idle mark, no rows, and no key for a circle that is not there.
    expect(
      screen.getByRole("img", { name: "Nothing held for anyone yet." }),
    ).toBeTruthy();
    expect(screen.queryByRole("listitem")).toBeNull();
  });

  it("opens a sheet from each key by keyboard, and Escape puts the keyboard back on the key", async () => {
    serve(await liveDesk(device(new Clock())));
    render(<GuardingPanel />);
    const user = userEvent.setup();
    for (const [id, label] of HEAD) {
      const key = elementById(id);
      key.focus();
      await user.keyboard("{Enter}");
      const dialog = await screen.findByRole("dialog", { name: label });
      expect(dialog.contains(document.activeElement)).toBe(true);
      await user.keyboard("{Escape}");
      await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
      expect(document.activeElement).toBe(key);
    }
  });
});

describe("a circle's row", () => {
  it("names the circle, whose it is, what is held and where it stands, and carries its two keys", async () => {
    const armed = await armedCircle(new Clock());
    serve(await liveDesk(who(armed, "Ada")));
    render(<GuardingPanel />);
    const row = screen
      .getByRole("heading", { level: 3, name: "Family" })
      .closest("li");
    if (!row) throw new Error("no row");
    expect(row.textContent).toMatch(/Held for [0-9a-f]{4}(-[0-9a-f]{4}){3}/);
    const inside = within(row);
    expect(inside.getByRole("img", { name: "Holds a share" })).toBeTruthy();
    expect(inside.getByRole("img", { name: "Held" })).toBeTruthy();
    expect(
      inside
        .getAllByRole("button")
        .map((key) => key.getAttribute("aria-label")),
    ).toEqual(["Answer a request for Family", "Leave Family"]);
  });

  it("marks a seat as only a seat", async () => {
    const armed = await armedCircle(new Clock(), { recovers: false });
    serve(await liveDesk(who(armed, "Ben")));
    render(<GuardingPanel />);
    expect(screen.getByRole("img", { name: "Seat only" })).toBeTruthy();
    expect(screen.queryByRole("img", { name: "Holds a share" })).toBeNull();
  });

  it("opens the request sheet from the row, ready for a request on that circle", async () => {
    const armed = await armedCircle(new Clock());
    serve(await liveDesk(who(armed, "Ada")));
    render(<GuardingPanel />);
    const user = userEvent.setup();
    const key = screen.getByRole("button", {
      name: "Answer a request for Family",
    });
    key.focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", {
      name: "Answer a request",
    });
    expect(within(dialog).getByLabelText("A request")).toBeTruthy();
    await user.keyboard("{Escape}");
    await waitFor(() => expect(document.activeElement).toBe(key));
  });

  it("leaves the circle from the row, and the keyboard lands on the head once the row has gone", async () => {
    const armed = await armedCircle(new Clock());
    const ada = who(armed, "Ada");
    serve(await liveDesk(ada));
    render(<GuardingPanel />);
    const user = userEvent.setup();
    screen.getByRole("button", { name: "Leave Family" }).focus();
    await user.keyboard("{Enter}");
    const dialog = await screen.findByRole("dialog", {
      name: "Leave a circle",
    });
    // The sheet opens on its close key, never on the irreversible one.
    expect(dialog.contains(document.activeElement)).toBe(true);
    expect(document.activeElement?.getAttribute("aria-label")).toBe("Close");
    await user.tab();
    await user.keyboard("{Enter}");

    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await ada.records.held()).toEqual([]);
    expect(
      screen.queryByRole("heading", { level: 3, name: "Family" }),
    ).toBeNull();
    expect(
      screen.getByRole("img", { name: "Nothing held for anyone yet." }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(elementById("guarding-accept")),
    );
  });

  it("closes a sheet without leaving, and keeps the circle", async () => {
    const armed = await armedCircle(new Clock());
    const ada = who(armed, "Ada");
    serve(await liveDesk(ada));
    render(<GuardingPanel />);
    const user = userEvent.setup();
    const key = screen.getByRole("button", { name: "Leave Family" });
    key.focus();
    await user.keyboard("{Enter}");
    await screen.findByRole("dialog", { name: "Leave a circle" });
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(key);
    expect(await ada.records.held()).toHaveLength(1);
  });
});
