/** @vitest-environment jsdom */
import { clearNotices } from "@opensesame/app-core/lib/notices.js";
import {
  Clock,
  armedCircle,
  device,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import { readDraft } from "@opensesame/app-core/lib/quorum/desk/index.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deskOf } from "../trusted-contacts.test-support.js";
import { InviteMoreSheet } from "./InviteMoreSheet.js";
import { addContact, recordCopies, sheetKey } from "./circles.test-support.js";

let restore: () => void = () => undefined;
let copies: string[] = [];

beforeEach(() => {
  const recorded = recordCopies();
  copies = recorded.copies;
  restore = recorded.restore;
});

afterEach(() => {
  cleanup();
  restore();
  clearNotices();
});

async function open(armed: Awaited<ReturnType<typeof armedCircle>>) {
  const onClose = vi.fn();
  const user = userEvent.setup();
  render(
    <InviteMoreSheet
      desk={await deskOf(armed.owner)}
      circleId={armed.circleId}
      onClose={onClose}
    />,
  );
  await screen.findByRole("button", { name: "Copy invitation" });
  return { user, onClose };
}

describe("inviting more people to a circle", () => {
  it("makes an invitation for the circle that exists and takes answers to it, with no way to set a rule", async () => {
    const clock = new Clock();
    const armed = await armedCircle(clock);
    const { user } = await open(armed);
    expect(
      screen.getByRole("dialog", { name: "Invite more people" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Set the rule" })).toBeNull();
    await user.click(screen.getByRole("button", { name: "Copy invitation" }));
    const invite = copies.at(-1) ?? "";
    expect(invite.startsWith("osq1.invite.")).toBe(true);
    await addContact(user, invite, "Dee", device(clock));
    expect(
      (await readDraft(armed.owner, armed.circleId))?.guardians.map(
        (g) => g.name,
      ),
    ).toEqual(["Dee"]);
    // The circle itself is not changed by inviting.
    expect(
      (await armed.owner.records.owned())[0]?.signedPolicy.policy.guardians,
    ).toHaveLength(3);
  });

  it("picks an invitation round up again with the people who answered it, and lets an empty one go", async () => {
    const clock = new Clock();
    const armed = await armedCircle(clock);
    const first = await open(armed);
    await first.user.click(
      screen.getByRole("button", { name: "Copy invitation" }),
    );
    const invite = copies.at(-1) ?? "";
    await addContact(first.user, invite, "Dee", device(clock));
    await first.user.click(sheetKey("Close"));
    expect(first.onClose).toHaveBeenCalled();
    cleanup();

    const again = await open(armed);
    expect(
      await screen.findByRole("img", { name: "Dee has answered" }),
    ).toBeTruthy();
    await again.user.click(
      screen.getByRole("button", { name: "Copy invitation" }),
    );
    expect(copies.at(-1)).toBe(invite);
    await again.user.click(screen.getByRole("button", { name: "Remove Dee" }));
    await waitFor(() =>
      expect(
        screen.queryByRole("img", { name: "Dee has answered" }),
      ).toBeNull(),
    );
    await again.user.click(sheetKey("Close"));
    await waitFor(async () =>
      expect(await readDraft(armed.owner, armed.circleId)).toBeNull(),
    );
  });
});
