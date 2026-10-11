/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { toB64url } from "@opensesame/app-core/lib/quorum/bytes.js";
import {
  Clock,
  type Device,
  device,
  who,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import { recordReceipt } from "@opensesame/app-core/lib/quorum/desk/index.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deskOf } from "../trusted-contacts.test-support.js";
import { TakeSheet } from "./TakeSheet.js";
import {
  captureCopies,
  dealtCircle,
  dismissable,
  invitation,
  replacedCircle,
  restoreCopies,
} from "./guarding.test-support.js";

let copied: string[];

beforeEach(() => {
  copied = captureCopies();
});

afterEach(() => {
  cleanup();
  clearNotices();
  restoreCopies();
});

type User = ReturnType<typeof userEvent.setup>;

async function open(guardian: Device) {
  const onClose = vi.fn();
  const onTaken = vi.fn();
  render(
    <TakeSheet
      desk={await deskOf(guardian)}
      onTaken={onTaken}
      onClose={onClose}
    />,
  );
  return { onClose, onTaken, user: userEvent.setup() };
}

/** Paste into the field from the close key, by keyboard, and stop on the key that acts on it. */
async function paste(user: User, text: string) {
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByLabelText("What an owner sent"),
  );
  await user.paste(text);
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Take what was sent" }),
  );
}

const TOOK = { timeout: 5000 };

describe("taking what an owner sent", () => {
  it("takes a welcome with a share by keyboard, says what it is first, and ends on the receipt to copy", async () => {
    const clock = new Clock();
    const { owner, ada, circleId, welcome } = await dealtCircle(clock);
    const { user, onTaken } = await open(ada);
    await paste(user, welcome);
    // What the paste is, before anything is done with it.
    expect(
      await screen.findByText("A welcome to Family, epoch 1"),
    ).toBeTruthy();
    expect(await ada.records.held()).toEqual([]);

    await user.keyboard("{Enter}");
    await screen.findByRole("img", { name: "Share taken" }, TOOK);
    const copy = screen.getByRole("button", { name: "Copy your receipt" });
    await waitFor(() => expect(document.activeElement).toBe(copy));
    expect(screen.queryByLabelText("What an owner sent")).toBeNull();
    expect(onTaken).toHaveBeenCalledTimes(1);

    await user.keyboard("{Enter}");
    await waitFor(() => expect(copied).toHaveLength(1));
    // The receipt is the owner's proof that the key reopened the share.
    const status = await recordReceipt(owner, circleId, copied[0] ?? "");
    expect(status.held).toHaveLength(1);

    const [held] = await ada.records.held();
    expect(held?.holding).not.toBeNull();
    expect(held?.state).toBe("held");
    expect(await ada.pending.list("guardian-pending:")).toEqual([]);
  });

  it("draws and copies none of the share or its receiving key", async () => {
    const clock = new Clock();
    const { ada, welcome } = await dealtCircle(clock);
    const { user } = await open(ada);
    await paste(user, welcome);
    await user.keyboard("{Enter}");
    await screen.findByRole("img", { name: "Share taken" }, TOOK);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(copied).toHaveLength(1));

    const [held] = await ada.records.held();
    const wrapped = JSON.stringify(held?.holding?.wrapped);
    const receiving = toB64url(held?.receivingKey ?? new Uint8Array());
    expect(wrapped.length).toBeGreaterThan(20);
    expect(receiving.length).toBeGreaterThan(20);
    const everything = `${document.body.innerHTML}${copied.join("")}`;
    expect(everything).not.toContain(receiving);
    expect(everything).not.toContain(wrapped);
    expect(everything).not.toContain(held?.holding?.wrapped.guardianId ?? "-");
  });

  it("takes only a seat in a circle that holds no shares, with no receipt to hand back", async () => {
    const clock = new Clock();
    const { ada, welcome } = await dealtCircle(clock, false);
    const { user } = await open(ada);
    await paste(user, welcome);
    await user.keyboard("{Enter}");
    await screen.findByRole("img", { name: "Seat taken" });
    expect(screen.queryByRole("button", { name: /Copy/ })).toBeNull();
    // Nothing to copy: the keyboard is on the way out.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getAllByRole("button", { name: "Close" }).at(-1),
      ),
    );
    const [held] = await ada.records.held();
    expect(held?.holding).toBeNull();
    expect(held?.seat.guardianId).toBeTruthy();
  });

  it("tells a guardian who is out of a circle, and one who must wait for a new share", async () => {
    const clock = new Clock();
    const { armed, notice } = await replacedCircle(clock);

    const cy = await open(who(armed, "Cy"));
    await paste(cy.user, notice);
    expect(
      await screen.findByText("A new policy for Family, epoch 2"),
    ).toBeTruthy();
    await cy.user.keyboard("{Enter}");
    await screen.findByRole(
      "img",
      { name: "You are no longer in Family" },
      TOOK,
    );
    expect(await who(armed, "Cy").records.held()).toEqual([]);
    cleanup();

    const ada = await open(who(armed, "Ada"));
    await paste(ada.user, notice);
    await ada.user.keyboard("{Enter}");
    await screen.findByRole(
      "img",
      { name: "Waiting for your new share in Family" },
      TOOK,
    );
    expect(await who(armed, "Ada").records.held()).toHaveLength(1);
    expect(listNotices()).toEqual([]);
  });

  it("refuses a welcome for a circle this device never agreed to, on the field and in the tray, and keeps the paste", async () => {
    const clock = new Clock();
    const { welcome } = await dealtCircle(clock);
    const stranger = device(clock);
    const { user } = await open(stranger);
    await paste(user, welcome);
    await user.keyboard("{Enter}");
    await screen.findByRole("img", {
      name: "This device has not accepted an invitation to that circle.",
    });
    const notice = listNotices().find(
      (one) => one.id === "trusted-contacts:guarding-take-in",
    );
    expect(notice?.body).toBe(
      "This device has not accepted an invitation to that circle.",
    );
    expect(document.body.textContent).not.toContain("not accepted");
    expect(screen.getByLabelText("What an owner sent")).toHaveProperty(
      "value",
      welcome,
    );
    expect(await stranger.records.held()).toEqual([]);
  });

  it("refuses a welcome it already took, as a failure on the field", async () => {
    const clock = new Clock();
    const { ada, welcome } = await dealtCircle(clock);
    const first = await open(ada);
    await paste(first.user, welcome);
    await first.user.keyboard("{Enter}");
    await screen.findByRole("img", { name: "Share taken" }, TOOK);
    cleanup();

    const again = await open(ada);
    await paste(again.user, welcome);
    await again.user.keyboard("{Enter}");
    await waitFor(() =>
      expect(
        listNotices().some(
          (one) => one.id === "trusted-contacts:guarding-take-in",
        ),
      ).toBe(true),
    );
    const said = listNotices().find(
      (one) => one.id === "trusted-contacts:guarding-take-in",
    )?.body;
    expect(said).toMatch(/\.$/);
    expect(screen.getByRole("img", { name: said })).toBeTruthy();
    expect(document.body.textContent).not.toContain(said ?? "-");
    expect(await ada.records.held()).toHaveLength(1);
  });

  it("marks a key that was not touched, keeps the agreement, and takes the share when tried again", async () => {
    const clock = new Clock();
    const { ada, welcome } = await dealtCircle(clock);
    const { person, allow } = dismissable(ada);
    const { user } = await open(person);
    await paste(user, welcome);
    await user.keyboard("{Enter}");
    await screen.findByRole(
      "img",
      { name: "The security key was not used." },
      TOOK,
    );
    expect(
      listNotices().find(
        (one) => one.id === "trusted-contacts:guarding-take-in",
      )?.body,
    ).toBe("The security key was not used.");
    expect(await ada.records.held()).toEqual([]);
    expect(await ada.pending.list("guardian-pending:")).toHaveLength(1);

    allow();
    await user.keyboard("{Enter}");
    await screen.findByRole("img", { name: "Share taken" }, TOOK);
    expect(await ada.records.held()).toHaveLength(1);
    expect(listNotices()).toEqual([]);
  });

  it("will not take an invitation here, before any key is pressed", async () => {
    const clock = new Clock();
    const { invite } = await invitation(clock);
    const { user } = await open(device(clock));
    await user.tab();
    await user.paste(invite);
    await screen.findByRole("img", {
      name: "This is an invite, not a welcome or a policy.",
    });
    expect(
      screen.getByRole("button", { name: "Take what was sent" }),
    ).toHaveProperty("disabled", true);
    expect(listNotices()).toEqual([]);
  });
});
