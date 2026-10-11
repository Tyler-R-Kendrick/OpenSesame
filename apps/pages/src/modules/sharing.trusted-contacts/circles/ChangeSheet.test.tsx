/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  Clock,
  armedCircle,
  device,
  who,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import type { Armed } from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import {
  applyNotice,
  readDraft,
  takeWelcome,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CirclesPanel } from "../CirclesPanel.js";
import {
  declareTargets,
  fieldValue,
} from "../trusted-contacts.test-support.js";
import {
  addContact,
  emergencyVault,
  openVaultWith,
  recordCopies,
  serveLiveDesk,
  sheetKey,
  someItems,
} from "./circles.test-support.js";

let restores: (() => void)[] = [];
let undeclare: () => void = () => undefined;
let copies: string[] = [];

beforeEach(() => {
  undeclare = declareTargets();
  const recorded = recordCopies();
  copies = recorded.copies;
  restores = [recorded.restore, openVaultWith(someItems())];
});

afterEach(() => {
  cleanup();
  for (const restore of restores.reverse()) restore();
  undeclare();
  clearNotices();
});

/** The harness's circles protect a folder called Emergency; `folder: false` is a vault that no longer has it. */
async function panel(armed: Armed, folder = true) {
  if (folder) restores.push(emergencyVault());
  const live = serveLiveDesk(armed.owner);
  restores.push(live.restore);
  await live.ready;
  const user = userEvent.setup();
  render(<CirclesPanel />);
  await user.click(screen.getByRole("button", { name: "Open Family" }));
  await screen.findByRole("dialog", { name: "Family" });
  return { user };
}

/** Dee is invited and answers, the way the Invite more people sheet takes her. */
async function inviteDee(
  armed: Armed,
  user: ReturnType<typeof userEvent.setup>,
) {
  await user.click(sheetKey("Invite more people"));
  await screen.findByRole("dialog", { name: "Invite more people" });
  await user.click(
    await screen.findByRole("button", { name: "Copy invitation" }),
  );
  const invite = copies.at(-1) ?? "";
  const dee = device(new Clock());
  await addContact(user, invite, "Dee", dee);
  await user.click(sheetKey("Close"));
  await screen.findByRole("dialog", { name: "Family" });
  return dee;
}

describe("changing a circle", () => {
  it("replaces a contact: Dee joins, Cy leaves and is told, and the circle is armed again once the new shares are held", async () => {
    const clock = new Clock();
    const armed = await armedCircle(clock);
    const { user } = await panel(armed);
    const dee = await inviteDee(armed, user);
    // The invitation round shows on the circle, ahead of the change.
    expect(
      await screen.findByRole("img", {
        name: "Dee joins when the circle is changed",
      }),
    ).toBeTruthy();

    await user.click(sheetKey("Change the circle"));
    const sheet = await screen.findByRole("dialog", {
      name: "Change the circle",
    });
    expect(within(sheet).getByText("2 of 3")).toBeTruthy();
    expect(
      within(sheet).getByRole("img", { name: "Dee joins at this epoch" }),
    ).toBeTruthy();
    const cy = within(sheet).getByRole("button", { name: "Remove Cy" });
    expect(cy.getAttribute("aria-pressed")).toBe("false");
    await user.click(cy);
    expect(cy.getAttribute("aria-pressed")).toBe("true");
    expect(
      within(sheet).getByRole("img", { name: "Cy leaves at this epoch" }),
    ).toBeTruthy();
    // Three people are left; two of three, as before.
    expect(fieldValue(within(sheet).getByLabelText("Needed"))).toBe("2");
    expect(within(sheet).getByLabelText("Minutes to approve")).toBeTruthy();

    clock.at(3600);
    await user.click(sheetKey("Make the new epoch"));
    await within(screen.getByRole("dialog")).findByRole("button", {
      name: "Save the recovery file",
    });
    expect(
      screen.getByRole("img", {
        name: "The earlier recovery file no longer opens this circle",
      }),
    ).toBeTruthy();
    // The desk kept them, so there is nothing to warn about.
    expect(
      screen.queryByRole("img", { name: "Packets are shown once" }),
    ).toBeNull();
    for (const name of ["Ada", "Ben", "Dee"]) {
      expect(
        screen.getByRole("button", { name: `Copy ${name}'s packet` }),
      ).toBeTruthy();
    }
    expect(
      screen.queryByRole("button", { name: "Copy Cy's packet" }),
    ).toBeNull();
    expect(
      screen.getByRole("button", { name: "Copy Cy's notice" }),
    ).toBeTruthy();

    const before = copies.length;
    for (const label of [
      "Copy Ada's packet",
      "Copy Ben's packet",
      "Copy Dee's packet",
      "Copy Cy's notice",
    ]) {
      await user.click(screen.getByRole("button", { name: label }));
    }
    await waitFor(() => expect(copies).toHaveLength(before + 4));
    const [adaPacket, benPacket, deePacket, cyNotice] = copies.slice(before);

    // Cy hears they are out; the others take their new shares and send receipts.
    expect(await applyNotice(who(armed, "Cy"), cyNotice ?? "")).toBe("retired");
    const receipts: string[] = [];
    for (const [holder, packet] of [
      [who(armed, "Ada"), adaPacket],
      [who(armed, "Ben"), benPacket],
      [dee, deePacket],
    ] as const) {
      const taken = await takeWelcome(holder, packet ?? "");
      expect(taken.epoch).toBe(2);
      receipts.push(taken.receipt ?? "");
    }
    for (const [index, name] of ["Ada", "Ben", "Dee"].entries()) {
      await user.click(screen.getByLabelText("A contact's receipt"));
      await user.paste(receipts[index] ?? "");
      await user.click(
        screen.getByRole("button", { name: "Add this receipt" }),
      );
      await screen.findByRole("img", { name: `${name} holds a share` });
    }
    expect(await screen.findByText("Armed")).toBeTruthy();

    const [owned] = await armed.owner.records.owned();
    expect(owned?.signedPolicy.policy.epoch).toBe(2);
    expect(owned?.signedPolicy.policy.guardians.map((g) => g.name)).toEqual([
      "Ada",
      "Ben",
      "Dee",
    ]);
    expect(owned?.state).toBe("armed");
    expect(await readDraft(armed.owner, armed.circleId)).toBeNull();
    expect(listNotices()).toEqual([]);

    // Back on the circle, the new epoch is what it says.
    await user.click(sheetKey("Close"));
    const circle = await screen.findByRole("dialog", { name: "Family" });
    expect(
      await within(circle).findByRole("img", { name: "Dee holds a share" }),
    ).toBeTruthy();
    expect(within(circle).queryByRole("img", { name: /Cy/ })).toBeNull();
    expect(document.activeElement).toBe(sheetKey("Change the circle"));
  }, 30_000);

  it("lets a newcomer go before the change, and a circle cannot be left with nobody in it", async () => {
    const armed = await armedCircle(new Clock());
    const { user } = await panel(armed);
    await inviteDee(armed, user);
    await user.click(sheetKey("Change the circle"));
    const sheet = await screen.findByRole("dialog", {
      name: "Change the circle",
    });
    await user.click(within(sheet).getByRole("button", { name: "Remove Dee" }));
    await waitFor(() =>
      expect(
        within(sheet).queryByRole("img", { name: "Dee joins at this epoch" }),
      ).toBeNull(),
    );
    expect((await readDraft(armed.owner, armed.circleId))?.guardians).toEqual(
      [],
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        within(sheet).getByLabelText("Needed"),
      ),
    );

    for (const name of ["Ada", "Ben", "Cy"]) {
      await user.click(
        within(sheet).getByRole("button", { name: `Remove ${name}` }),
      );
    }
    expect(
      await within(sheet).findByRole("img", {
        name: "A circle needs at least one contact.",
      }),
    ).toBeTruthy();
    expect(within(sheet).queryByLabelText("Needed")).toBeNull();
    expect(
      within(sheet)
        .getByRole("button", { name: "Make the new epoch" })
        .hasAttribute("disabled"),
    ).toBe(true);
  });

  it("marks a rule the desk refuses on its field, and leaves the circle as it was", async () => {
    const armed = await armedCircle(new Clock());
    const { user } = await panel(armed);
    await user.click(sheetKey("Change the circle"));
    const sheet = await screen.findByRole("dialog", {
      name: "Change the circle",
    });
    const needed = within(sheet).getByLabelText("Needed");
    await user.clear(needed);
    await user.type(needed, "5");
    expect(
      await within(sheet).findByRole("img", {
        name: "Group All needs more guardians than it has.",
      }),
    ).toBeTruthy();
    expect(
      within(sheet)
        .getByRole("button", { name: "Make the new epoch" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(listNotices()).toEqual([]);
    expect(
      (await armed.owner.records.owned())[0]?.signedPolicy.policy.epoch,
    ).toBe(1);
  });

  it("shows a change that could not be signed on the key and in the tray, and changes nothing", async () => {
    const armed = await armedCircle(new Clock());
    const { user } = await panel(armed);
    await user.click(sheetKey("Change the circle"));
    const sheet = await screen.findByRole("dialog", {
      name: "Change the circle",
    });
    Object.assign(armed.owner, {
      records: {
        ...armed.owner.records,
        saveOwned: async () => {
          throw new Error("disk");
        },
      },
    });
    await user.click(
      within(sheet).getByRole("button", { name: "Make the new epoch" }),
    );
    expect(
      await within(sheet).findByRole("img", {
        name: "That step did not finish.",
      }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        listNotices().some((n) => n.id === "trusted-contacts:circle-change"),
      ).toBe(true),
    );
    expect(
      within(sheet).queryByRole("button", { name: "Save the recovery file" }),
    ).toBeNull();
  });

  it("changes a circle of approvals only without a recovery file or receipts", async () => {
    const armed = await armedCircle(new Clock(), { recovers: false });
    const { user } = await panel(armed);
    await user.click(sheetKey("Change the circle"));
    const sheet = await screen.findByRole("dialog", {
      name: "Change the circle",
    });
    expect(
      within(sheet).getByLabelText("Hours before it takes effect"),
    ).toBeTruthy();
    await user.click(
      within(sheet).getByRole("button", { name: "Make the new epoch" }),
    );
    await screen.findByRole("button", { name: "Copy Ada's packet" });
    expect(
      screen.queryByRole("button", { name: "Save the recovery file" }),
    ).toBeNull();
    expect(screen.queryByLabelText("A contact's receipt")).toBeNull();
    expect(
      screen.queryByRole("img", {
        name: "The earlier recovery file no longer opens this circle",
      }),
    ).toBeNull();
    expect(
      (await armed.owner.records.owned())[0]?.signedPolicy.policy.epoch,
    ).toBe(2);
  });

  it("will not widen a circle to the whole vault when the folder it protects has gone", async () => {
    const armed = await armedCircle(new Clock());
    const { user } = await panel(armed, false);
    await user.click(sheetKey("Change the circle"));
    const sheet = await screen.findByRole("dialog", {
      name: "Change the circle",
    });
    await user.click(
      within(sheet).getByRole("button", { name: "Make the new epoch" }),
    );
    expect(
      await within(sheet).findByRole("img", {
        name: "That folder is not in this vault.",
      }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(
        listNotices().some((n) => n.id === "trusted-contacts:circle-change"),
      ).toBe(true),
    );
    expect(
      (await armed.owner.records.owned())[0]?.signedPolicy.policy.epoch,
    ).toBe(1);
    expect(
      within(sheet).queryByRole("button", { name: "Save the recovery file" }),
    ).toBeNull();
  });
});
