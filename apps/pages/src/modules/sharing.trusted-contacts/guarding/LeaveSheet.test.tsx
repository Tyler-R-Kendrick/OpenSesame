/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  Clock,
  type Device,
  armedCircle,
  device,
  who,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import { keyFingerprint } from "@opensesame/app-core/lib/quorum/request.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { deskOf } from "../trusted-contacts.test-support.js";
import { LeaveSheet } from "./LeaveSheet.js";

afterEach(() => {
  cleanup();
  clearNotices();
});

async function open(
  guardian: Device,
  ports: Device = guardian,
  onLeft = vi.fn(),
) {
  const desk = { ...(await deskOf(guardian)), ports };
  const [held] = desk.held;
  if (!held) throw new Error("nothing held");
  render(
    <LeaveSheet desk={desk} held={held} onLeft={onLeft} onClose={vi.fn()} />,
  );
  return { held, onLeft, user: userEvent.setup() };
}

describe("leaving a circle", () => {
  it("opens on the close key, offers one irreversible key and no Keep, and does it by keyboard", async () => {
    const armed = await armedCircle(new Clock());
    const ada = who(armed, "Ada");
    const { held, onLeft, user } = await open(ada);
    const { policy } = held.seat.signedPolicy;

    expect(document.activeElement).toBe(
      screen.getAllByRole("button", { name: "Close" }).at(-1),
    );
    expect(screen.getByText("Family")).toBeTruthy();
    expect(screen.getByText(keyFingerprint(policy.ownerKey))).toBeTruthy();
    expect(screen.getByText("a share")).toBeTruthy();
    expect(screen.getByText("Not told")).toBeTruthy();
    // Close (twice: the scrim and the head) and the one act. Nothing that only says Keep.
    expect(
      screen
        .getAllByRole("button")
        .map((key) => key.getAttribute("aria-label")),
    ).toEqual(["Close", "Close", "Leave this circle"]);
    const leave = screen.getByRole("button", { name: "Leave this circle" });
    expect(leave.className).toBe("go");
    expect(leave.className).not.toContain("danger");

    await user.tab();
    expect(document.activeElement).toBe(leave);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(onLeft).toHaveBeenCalledTimes(1));
    expect(await ada.records.held()).toEqual([]);
    expect(listNotices()).toEqual([]);
  });

  it("names a seat as a seat", async () => {
    const armed = await armedCircle(new Clock(), { recovers: false });
    await open(who(armed, "Ben"));
    expect(screen.getByText("a seat")).toBeTruthy();
    expect(screen.queryByText("a share")).toBeNull();
  });

  it("marks a refusal on the card and in the tray, keeps the circle, and leaves the keyboard on the key", async () => {
    const clock = new Clock();
    const armed = await armedCircle(clock);
    const ada = who(armed, "Ada");
    // The records listed are Ada's, but the device asked to forget them holds nothing.
    const { onLeft, user } = await open(ada, device(clock));
    await user.tab();
    await user.keyboard("{Enter}");

    await screen.findByRole("img", {
      name: "This device holds nothing for that circle.",
    });
    expect(
      listNotices().find((one) => one.id === "trusted-contacts:guarding-leave")
        ?.title,
    ).toBe("Leave a circle");
    expect(document.body.textContent).not.toContain("holds nothing");
    expect(onLeft).not.toHaveBeenCalled();
    expect(await ada.records.held()).toHaveLength(1);
    const leave = screen.getByRole("button", { name: "Leave this circle" });
    await waitFor(() => expect(document.activeElement).toBe(leave));
  });
});
