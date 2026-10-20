import {
  Clock,
  type Device,
  armedCircle,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { CirclesPanel } from "../CirclesPanel.js";
import { declareTargets } from "../trusted-contacts.test-support.js";
import {
  installSheetHarness,
  serveLiveDesk,
  sheetKey,
} from "./circles.test-support.js";
import { makeCircle } from "./new-circle.test-support.js";

const h = installSheetHarness(declareTargets);

const packetsKey = () =>
  within(screen.getByRole("dialog")).queryByRole("button", {
    name: "Hand out the packets",
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

describe("a circle closed halfway through being dealt", () => {
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
