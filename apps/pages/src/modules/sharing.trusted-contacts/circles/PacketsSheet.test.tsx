/** @vitest-environment jsdom */
import { listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  Clock,
  type Device,
  armedCircle,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CirclesPanel } from "../CirclesPanel.js";
import { declareTargets } from "../trusted-contacts.test-support.js";
import {
  installSheetHarness,
  serveLiveDesk,
  sheetKey,
  take,
} from "./circles.test-support.js";
import { makeCircle } from "./new-circle.test-support.js";

const h = installSheetHarness(declareTargets);

/** A store that will not keep what was dealt. */
const refusing = (owner: Device): Device => ({
  ...owner,
  pending: {
    ...owner.pending,
    write: async (key, value) => {
      if (key.startsWith("dealt:")) throw new Error("too large");
      return owner.pending.write(key, value);
    },
  },
});

/** The page opened again over the same stores, on the circle's own sheet. */
async function reopen(owner: Device) {
  cleanup();
  const live = serveLiveDesk(owner);
  h.restores.push(live.restore);
  await live.ready;
  const user = userEvent.setup();
  render(<CirclesPanel />);
  await user.click(screen.getByRole("button", { name: "Open Family" }));
  await screen.findByRole("dialog", { name: "Family" });
  return { user };
}

const packetsKey = () =>
  within(screen.getByRole("dialog")).queryByRole("button", {
    name: "Hand out the packets",
  });

/** Copy a packet from the open sheet and have the contact take it, returning their receipt. */
async function receiptFor(
  user: ReturnType<typeof userEvent.setup>,
  contact: Device,
  label: string,
): Promise<string> {
  await user.click(screen.getByRole("button", { name: label }));
  await waitFor(() =>
    expect(h.copies.at(-1)?.startsWith("osq1.welcome.")).toBe(true),
  );
  return (await take(contact, h.copies.at(-1) ?? "")) ?? "";
}

async function addReceipt(
  user: ReturnType<typeof userEvent.setup>,
  receipt: string,
  name: string,
) {
  await user.click(screen.getByLabelText("A contact's receipt"));
  await user.paste(receipt);
  await user.click(screen.getByRole("button", { name: "Add this receipt" }));
  await screen.findByRole("img", { name: `${name} holds a share` });
}

describe("a circle closed halfway through being dealt", () => {
  it("has its packets, its file and its receipt field when the page is opened again, until the last receipt", async () => {
    const made = await makeCircle(h.copies, ["Ada", "Ben", "Cy"]);
    // Nothing on the screen says they are shown once: they are kept.
    expect(
      screen.queryByRole("img", { name: "Packets are shown once" }),
    ).toBeNull();
    // Ada has hers before the sheet is closed.
    await addReceipt(
      made.user,
      await receiptFor(
        made.user,
        made.devices.get("Ada") ?? made.owner,
        "Copy Ada's packet",
      ),
      "Ada",
    );
    await made.user.click(sheetKey("Close"));
    expect(await made.owner.pending.list("dealt:")).toHaveLength(1);

    const { user } = await reopen(made.owner);
    const sheet = screen.getByRole("dialog", { name: "Family" });
    expect(
      await within(sheet).findByRole("img", { name: "Ada holds a share" }),
    ).toBeTruthy();
    expect(
      within(sheet).getByRole("img", { name: "Waiting for Ben's receipt" }),
    ).toBeTruthy();
    const commands = within(sheet).getByRole("group", {
      name: "Circle commands",
    });
    expect(
      within(commands)
        .getAllByRole("button")
        .map((k) => k.getAttribute("aria-label")),
    ).toEqual([
      "Hand out the packets",
      "Invite more people",
      "Change the circle",
      "Ask contacts to approve a share",
      "Cancel a request",
    ]);

    await user.click(
      within(commands).getByRole("button", { name: "Hand out the packets" }),
    );
    const packets = await screen.findByRole("dialog", {
      name: "Hand out the packets",
    });
    for (const name of ["Ada", "Ben", "Cy"]) {
      expect(
        await within(packets).findByRole("button", {
          name: `Copy ${name}'s packet`,
        }),
      ).toBeTruthy();
    }
    expect(
      within(packets).getByRole("button", { name: "Save the recovery file" }),
    ).toBeTruthy();
    expect(within(packets).getByLabelText("A contact's receipt")).toBeTruthy();
    expect(
      within(packets).getByRole("img", { name: "Ada holds a share" }),
    ).toBeTruthy();
    expect(
      within(packets).queryByRole("img", { name: "Packets are shown once" }),
    ).toBeNull();
    expect(within(packets).queryByText("Armed")).toBeNull();

    // The packets that were kept are the ones that work.
    await addReceipt(
      user,
      await receiptFor(
        user,
        made.devices.get("Ben") ?? made.owner,
        "Copy Ben's packet",
      ),
      "Ben",
    );
    expect(await made.owner.pending.list("dealt:")).toHaveLength(1);
    await addReceipt(
      user,
      await receiptFor(
        user,
        made.devices.get("Cy") ?? made.owner,
        "Copy Cy's packet",
      ),
      "Cy",
    );
    expect(await screen.findByText("Armed")).toBeTruthy();
    // With the last receipt the desk lets them go; what is on the screen stays.
    expect(await made.owner.pending.list("dealt:")).toEqual([]);
    expect(
      screen.getByRole("button", { name: "Copy Ada's packet" }),
    ).toBeTruthy();

    await user.click(sheetKey("Close"));
    const circle = await screen.findByRole("dialog", { name: "Family" });
    expect(within(circle).getByRole("img", { name: /^Armed/ })).toBeTruthy();
    expect(
      await within(circle).findByRole("img", { name: "Cy holds a share" }),
    ).toBeTruthy();
    await waitFor(() => expect(packetsKey()).toBeNull());
    expect(document.activeElement).toBe(sheetKey("Close"));
    expect(listNotices()).toEqual([]);
  }, 30_000);

  it("is opened again by the circle's key after the packets sheet is closed with receipts still to come", async () => {
    const made = await makeCircle(h.copies, ["Ada", "Ben", "Cy"]);
    await made.user.click(sheetKey("Close"));
    const { user } = await reopen(made.owner);
    await user.click(
      await screen.findByRole("button", { name: "Hand out the packets" }),
    );
    await screen.findByRole("dialog", { name: "Hand out the packets" });
    await user.keyboard("{Escape}");
    // The circle's sheet comes back with the keyboard on its own close key, and the key to try again.
    await screen.findByRole("dialog", { name: "Family" });
    expect(document.activeElement).toBe(sheetKey("Close"));
    expect(
      await screen.findByRole("button", { name: "Hand out the packets" }),
    ).toBeTruthy();
  });

  it("says the packets are shown once only where they could not be kept, and then offers nothing later", async () => {
    const made = await makeCircle(
      h.copies,
      ["Ada", "Ben", "Cy"],
      undefined,
      refusing,
    );
    expect(
      screen.getByRole("img", { name: "Packets are shown once" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Copy Ada's packet" }),
    ).toBeTruthy();
    await made.user.click(sheetKey("Close"));
    expect(await made.owner.pending.list("dealt:")).toEqual([]);
    await reopen(made.owner);
    await screen.findByRole("img", { name: /^Waiting for Ada/ });
    expect(packetsKey()).toBeNull();
  });

  it("is forgotten when the circle is retired", async () => {
    const made = await makeCircle(h.copies, ["Ada", "Ben", "Cy"]);
    await made.user.click(sheetKey("Close"));
    const { user } = await reopen(made.owner);
    expect(
      await within(screen.getByRole("dialog")).findByRole("button", {
        name: "Hand out the packets",
      }),
    ).toBeTruthy();
    expect(await made.owner.pending.list("dealt:")).toHaveLength(1);
    await user.click(sheetKey("Retire this circle"));
    await user.click(sheetKey("Retire this circle for good"));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(await made.owner.pending.list("dealt:")).toEqual([]);
    expect(await made.owner.records.owned()).toEqual([]);
  });

  it("is kept for a circle of approvals only, with no file and no receipts to wait for", async () => {
    const made = await makeCircle(h.copies, ["Ada", "Ben"], "Approvals only");
    await made.user.click(sheetKey("Close"));
    const { user } = await reopen(made.owner);
    // It is armed from the start, and still has people to hand a packet to.
    expect(
      within(screen.getByRole("dialog")).getByRole("img", { name: /^Armed/ }),
    ).toBeTruthy();
    await user.click(
      await screen.findByRole("button", { name: "Hand out the packets" }),
    );
    const packets = await screen.findByRole("dialog", {
      name: "Hand out the packets",
    });
    expect(
      await within(packets).findByRole("button", { name: "Copy Ada's packet" }),
    ).toBeTruthy();
    expect(
      within(packets).getByRole("button", { name: "Copy Ben's packet" }),
    ).toBeTruthy();
    expect(
      within(packets).queryByRole("button", { name: "Save the recovery file" }),
    ).toBeNull();
    expect(within(packets).queryByLabelText("A contact's receipt")).toBeNull();
  });
});

describe("a circle with nothing to hand out", () => {
  it("offers no packets: the key is not drawn once every contact holds a share", async () => {
    const armed = await armedCircle(new Clock());
    const { user } = await reopen(armed.owner);
    void user;
    await within(screen.getByRole("dialog")).findByRole("img", {
      name: "Ada holds a share",
    });
    expect(packetsKey()).toBeNull();
  });
});
