/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { toB64url } from "@opensesame/app-core/lib/quorum/bytes.js";
import {
  Clock,
  armedCircle,
  oneGroup,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import type { Armed } from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import {
  askToShare,
  reissue,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import { PAYLOAD } from "@opensesame/app-core/lib/quorum/world.test-support.js";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CirclesPanel } from "../CirclesPanel.js";
import { declareTargets } from "../trusted-contacts.test-support.js";
import {
  openVaultWith,
  recordCopies,
  serveLiveDesk,
  sheetKey,
  someItems,
} from "./circles.test-support.js";

let restores: (() => void)[] = [];
let undeclare: () => void = () => undefined;

beforeEach(() => {
  undeclare = declareTargets();
  restores = [recordCopies().restore, openVaultWith(someItems())];
});

afterEach(() => {
  cleanup();
  for (const restore of restores.reverse()) restore();
  undeclare();
  clearNotices();
});

async function panel(armed: Armed) {
  const live = serveLiveDesk(armed.owner);
  restores.push(live.restore);
  await live.ready;
  const user = userEvent.setup();
  render(<CirclesPanel />);
  return { user, live };
}

const dialog = () => screen.getByRole("dialog");

describe("the Circles panel", () => {
  it("has one key on its head, a target for the walkthrough, and one key on each circle's row", async () => {
    const armed = await armedCircle(new Clock());
    await panel(armed);
    const head = screen.getByRole("group", { name: "Circles commands" });
    const keys = within(head).getAllByRole("button");
    expect(keys.map((k) => k.getAttribute("aria-label"))).toEqual([
      "Start a circle",
    ]);
    expect(keys[0]?.getAttribute("title")).toBe("Start a circle");
    expect(keys[0]?.getAttribute("data-guide-targets")).toContain("circle.new");
    const row = screen
      .getByRole("heading", { level: 3, name: "Family" })
      .closest("li");
    if (!row) throw new Error("no row");
    const open = within(row).getByRole("button", { name: "Open Family" });
    expect(open.getAttribute("title")).toBe("Open Family");
    expect(within(row).getAllByRole("button")).toHaveLength(1);
  });

  it("starts a circle from the head key and gives the keyboard back to it", async () => {
    const armed = await armedCircle(new Clock());
    const { user } = await panel(armed);
    const head = screen.getByRole("button", { name: "Start a circle" });
    head.focus();
    await user.keyboard("{Enter}");
    expect(
      await screen.findByRole("dialog", { name: "Start a circle" }),
    ).toBeTruthy();
    expect(document.activeElement).toBe(sheetKey("Close"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(head);
  });
});

describe("a circle's sheet", () => {
  it("shows the rule, the epoch, what it protects, who holds a share, and no secret", async () => {
    const armed = await armedCircle(new Clock());
    const { user } = await panel(armed);
    await user.click(screen.getByRole("button", { name: "Open Family" }));
    const sheet = await screen.findByRole("dialog", { name: "Family" });
    expect(within(sheet).getByText("2 of 3")).toBeTruthy();
    expect(within(sheet).getByText("Epoch")).toBeTruthy();
    expect(within(sheet).getByText("Emergency")).toBeTruthy();
    expect(within(sheet).getByRole("img", { name: /^Armed/ })).toBeTruthy();
    for (const name of ["Ada", "Ben", "Cy"]) {
      expect(
        await within(sheet).findByRole("img", {
          name: `${name} holds a share`,
        }),
      ).toBeTruthy();
    }
    const commands = within(sheet).getByRole("group", {
      name: "Circle commands",
    });
    expect(
      within(commands)
        .getAllByRole("button")
        .map((k) => k.getAttribute("aria-label")),
    ).toEqual([
      "Invite more people",
      "Change the circle",
      "Ask contacts to approve a share",
      "Cancel a request",
    ]);
    const [owned] = await armed.owner.records.owned();
    expect(document.body.innerHTML).not.toContain(
      toB64url(owned?.ownerSecretKey ?? new Uint8Array()),
    );
    expect(listNotices()).toEqual([]);
  });

  it("says who is still to take their part after a change, and warns when everyone is needed", async () => {
    const clock = new Clock();
    const armed = await armedCircle(clock, { threshold: 3 });
    await reissue(armed.owner, armed.circleId, {
      drop: [],
      rule: oneGroup(armed.guardianIds, 3),
      payload: PAYLOAD,
    });
    const { user } = await panel(armed);
    await user.click(screen.getByRole("button", { name: "Open Family" }));
    const sheet = await screen.findByRole("dialog", { name: "Family" });
    expect(
      await within(sheet).findByRole("img", {
        name: "Waiting for Ada's receipt",
      }),
    ).toBeTruthy();
    expect(
      within(sheet).queryByRole("img", { name: "Ada holds a share" }),
    ).toBeNull();
    expect(
      within(sheet).getByRole("img", { name: /^Waiting for contacts/ }),
    ).toBeTruthy();
    expect(
      within(sheet).getByRole("img", {
        name: "Group all needs everyone: one refusal or one lost key blocks recovery.",
      }),
    ).toBeTruthy();
  });

  it("has no share marks on a circle of approvals only", async () => {
    const armed = await armedCircle(new Clock(), { recovers: false });
    const { user } = await panel(armed);
    await user.click(screen.getByRole("button", { name: "Open Family" }));
    const sheet = await screen.findByRole("dialog", { name: "Family" });
    expect(within(sheet).getByText("Emergency")).toBeTruthy();
    expect(
      within(sheet).queryByRole("img", { name: /holds a share|Waiting for/ }),
    ).toBeNull();
    expect(within(sheet).getAllByRole("listitem")).toHaveLength(3);
  });

  it("gives the sheet to a ceremony and takes it back with the keyboard on the key that opened it", async () => {
    const armed = await armedCircle(new Clock());
    const { user } = await panel(armed);
    await user.click(screen.getByRole("button", { name: "Open Family" }));
    await screen.findByRole("dialog", { name: "Family" });
    await user.click(sheetKey("Cancel a request"));
    expect(
      await screen.findByRole("dialog", { name: "Cancel a request" }),
    ).toBeTruthy();
    expect(screen.queryByRole("dialog", { name: "Family" })).toBeNull();
    await user.keyboard("{Escape}");
    await screen.findByRole("dialog", { name: "Family" });
    expect(document.activeElement).toBe(sheetKey("Cancel a request"));
    await user.keyboard("{Escape}");
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Open Family" }),
    );
  });

  it("lists a request waiting on the contacts and opens it where it stands", async () => {
    const armed = await armedCircle(new Clock(), { recovers: false });
    await askToShare(armed.owner, armed.circleId, {
      principalId: "local_5f5a5c1e-0000-4000-8000-000000000001",
      resourceKind: "item",
      resourceId: "bank-login",
      resourceLabel: "Bank login",
      policy: "read",
      durationSeconds: 3600,
    });
    const { user } = await panel(armed);
    await user.click(screen.getByRole("button", { name: "Open Family" }));
    const sheet = await screen.findByRole("dialog", { name: "Family" });
    const list = await within(sheet).findByRole("list", { name: "Requests" });
    expect(within(list).getByText("Bank login · read")).toBeTruthy();
    expect(within(list).getByText("0 of 3 approved")).toBeTruthy();
    expect(
      within(list).getByRole("img", { name: /^Collecting approvals until / }),
    ).toBeTruthy();
    await user.click(
      within(list).getByRole("button", {
        name: "Open the request for Bank login",
      }),
    );
    const ask = await screen.findByRole("dialog", {
      name: "Ask contacts to approve a share",
    });
    expect(
      await within(ask).findByRole("button", { name: "Copy request" }),
    ).toBeTruthy();
    expect(within(ask).getByLabelText("Approvals")).toBeTruthy();
  });
});

describe("retiring a circle", () => {
  it("takes two presses, forgets the circle, closes the sheet and puts the keyboard on the head key", async () => {
    const armed = await armedCircle(new Clock());
    const { user } = await panel(armed);
    await user.click(screen.getByRole("button", { name: "Open Family" }));
    await screen.findByRole("dialog", { name: "Family" });
    const retire = sheetKey("Retire this circle");
    await user.click(retire);
    // The first press only changes what the key says.
    expect(await armed.owner.records.owned()).toHaveLength(1);
    const again = sheetKey("Retire this circle for good");
    expect(again).toBe(retire);
    await user.click(again);
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await armed.owner.records.owned()).toEqual([]);
    expect(screen.getByRole("img", { name: "No circles yet." })).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Start a circle" }),
      ),
    );
    expect(listNotices()).toEqual([]);
  });

  it("shows a circle that would not go on the key and in the tray, and puts the key back", async () => {
    const armed = await armedCircle(new Clock());
    const owner = armed.owner;
    const records = owner.records;
    Object.assign(owner, {
      records: {
        ...records,
        removeOwned: async () => {
          throw new Error("disk");
        },
      },
    });
    const { user } = await panel(armed);
    await user.click(screen.getByRole("button", { name: "Open Family" }));
    await screen.findByRole("dialog", { name: "Family" });
    await user.click(sheetKey("Retire this circle"));
    await user.click(sheetKey("Retire this circle for good"));
    expect(
      await within(dialog()).findByRole("img", {
        name: "That step did not finish.",
      }),
    ).toBeTruthy();
    expect(sheetKey("Retire this circle")).toBeTruthy();
    await waitFor(() =>
      expect(
        listNotices().some((n) => n.id === "trusted-contacts:circle-retire"),
      ).toBe(true),
    );
    expect(await records.owned()).toHaveLength(1);
  });

  it("closes the sheet of a circle that is gone when the records are read again", async () => {
    const armed = await armedCircle(new Clock());
    const { user, live } = await panel(armed);
    await user.click(screen.getByRole("button", { name: "Open Family" }));
    await screen.findByRole("dialog", { name: "Family" });
    await armed.owner.records.removeOwned(armed.circleId);
    await act(() => live.refresh());
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("img", { name: "No circles yet." })).toBeTruthy();
  });
});
