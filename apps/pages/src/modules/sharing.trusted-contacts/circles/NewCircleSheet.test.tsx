/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { toB64url } from "@opensesame/app-core/lib/quorum/bytes.js";
import {
  Clock,
  device,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import { unfinishedCircle } from "@opensesame/app-core/lib/quorum/desk/index.js";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  deskOf,
  elementById,
  fieldValue,
  isDisabled,
} from "../trusted-contacts.test-support.js";
import { NewCircleSheet } from "./NewCircleSheet.js";
import {
  answer,
  byId,
  byName,
  contacts,
  openVaultWith,
  recordCopies,
  someItems,
  tabTo,
} from "./circles.test-support.js";

let restores: (() => void)[] = [];
let copies: string[] = [];

beforeEach(() => {
  const recorded = recordCopies();
  copies = recorded.copies;
  restores = [recorded.restore, openVaultWith(someItems())];
});

afterEach(() => {
  cleanup();
  for (const restore of restores.reverse()) restore();
  clearNotices();
});

async function open(clock = new Clock()) {
  const owner = device(clock);
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(<NewCircleSheet desk={await deskOf(owner)} onClose={onClose} />);
  await screen.findByLabelText("Name");
  return { clock, owner, onClose, user };
}

const key = (name: string) =>
  within(screen.getByRole("dialog")).getByRole("button", { name });

describe("Start a circle", () => {
  it("opens on its close key with a supplied name and no protection choices", async () => {
    await open();
    expect(document.activeElement).toBe(key("Close"));
    expect(screen.getByRole("dialog", { name: "Start a circle" })).toBeTruthy();
    expect(screen.getByLabelText("Name")).toHaveProperty("value", "Circle 1");
    expect(
      screen.queryByRole("radiogroup", { name: "What it protects" }),
    ).toBeNull();
    expect(screen.queryByLabelText("Folder")).toBeNull();
    expect(isDisabled(key("Make the invitation"))).toBe(false);
    // Nothing is drawn but fields and keys: no prose, no failure.
    expect(document.querySelectorAll("p")).toHaveLength(1);
    expect(document.querySelector(".found__top")).toBeNull();
  });

  it("lets go of a circle with nobody in it when the sheet is closed, and keeps one with somebody", async () => {
    const { user, owner, onClose } = await open();
    await user.type(screen.getByLabelText("Name"), "Family");
    await user.click(key("Make the invitation"));
    await screen.findByRole("button", { name: "Copy invitation" });
    expect(await unfinishedCircle(owner)).not.toBeNull();
    await user.click(key("Close"));
    expect(onClose).toHaveBeenCalledTimes(1);
    await waitFor(async () => expect(await unfinishedCircle(owner)).toBeNull());
  });
});

describe("making a circle by keyboard", () => {
  it("goes from a name to an armed circle, one key at a time, and never shows a secret", async () => {
    const { clock, owner, user } = await open();
    const people = contacts(clock, ["Ada", "Ben", "Cy"]);

    // Name. The sheet supplies one; replace it.
    await tabTo(user, byId("tcc-name"), "the name field");
    await user.clear(screen.getByLabelText("Name"));
    await user.keyboard("Family");
    await user.keyboard("{Enter}");

    // People: focus lands on the first thing to do, the invitation's Copy key.
    const copy = await screen.findByRole("button", { name: "Copy invitation" });
    await waitFor(() => expect(document.activeElement).toBe(copy));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(copies).toHaveLength(1));
    const invite = copies[0] ?? "";
    expect(invite.startsWith("osq1.invite.")).toBe(true);
    expect(
      screen.getByRole("img", { name: "Invitation QR code" }),
    ).toBeTruthy();

    expect(isDisabled(key("Set the rule"))).toBe(true);
    for (const [name, contact] of people) {
      const enrollment = await answer(contact, invite, name);
      await tabTo(user, byId("tcc-enrollment"), "the answer field");
      await user.paste(enrollment);
      expect(await screen.findByText(`${name} · 1 key`)).toBeTruthy();
      await user.tab();
      expect(document.activeElement).toBe(key("Add this contact"));
      await user.keyboard("{Enter}");
      await screen.findByRole("img", { name: `${name} has answered` });
      // Focus is back on the field, ready for the next contact.
      await waitFor(() =>
        expect(document.activeElement).toBe(elementById("tcc-enrollment")),
      );
    }
    expect(
      within(screen.getByRole("list", { name: "Contacts" })).getAllByRole(
        "listitem",
      ),
    ).toHaveLength(3);

    // Rule: three contacts default to two of three.
    await tabTo(user, byName("Set the rule"), "Set the rule");
    await user.keyboard("{Enter}");
    const needed = await screen.findByLabelText("Needed");
    expect(fieldValue(needed)).toBe("2");
    await waitFor(() =>
      expect(document.activeElement?.tagName).not.toBe("BODY"),
    );
    expect(screen.queryByRole("img", { name: /./ })).toBeNull();

    // Clocks.
    await tabTo(user, byName("Set the clocks"), "Set the clocks");
    await user.keyboard("{Enter}");
    expect(fieldValue(await screen.findByLabelText("Minutes to approve"))).toBe(
      "10",
    );
    expect(
      fieldValue(screen.getByLabelText("Hours before a share is released")),
    ).toBe("24");
    expect(fieldValue(screen.getByLabelText("Days a request lasts"))).toBe("7");
    expect(
      screen
        .getByRole("switch", { name: "Require a PIN or biometric" })
        .getAttribute("aria-checked"),
    ).toBe("true");
    await tabTo(user, byName("Make the circle"), "Make the circle");
    await user.keyboard("{Enter}");

    // Packets: one for each contact, and no recovery file or receipts.
    await screen.findByRole("button", { name: "Copy Ada's packet" });
    expect(
      screen.queryByRole("img", { name: "Packets are shown once" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Save the recovery file" }),
    ).toBeNull();
    expect(screen.queryByLabelText("A contact's receipt")).toBeNull();
    const before = copies.length;
    for (const name of ["Ada", "Ben", "Cy"]) {
      await user.click(
        screen.getByRole("button", { name: `Copy ${name}'s packet` }),
      );
    }
    await waitFor(() => expect(copies).toHaveLength(before + 3));

    const [armed] = await owner.records.owned();
    expect(armed?.state).toBe("armed");
    expect(armed?.signedPolicy.policy.label).toBe("Family");
    expect(armed?.signedPolicy.policy.collection).toBe("Approvals only");

    // No secret reached the page or the clipboard.
    const secret = toB64url(armed?.ownerSecretKey ?? new Uint8Array());
    expect(document.body.innerHTML).not.toContain(secret);
    expect(copies.some((text) => text.includes(secret))).toBe(false);
    expect(document.body.innerHTML).not.toContain("router-pass-1");
    expect(copies.some((text) => text.includes("router-pass-1"))).toBe(false);
    expect(listNotices()).toEqual([]);
  }, 30_000);
});
