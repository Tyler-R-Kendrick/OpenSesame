/** @vitest-environment jsdom */
/**
 * The owner's addresses, as the joiner is asked about them (ADR 0150 §6,
 * amended 2026-10-24): each one is shown, Allow takes them, the other key
 * joins without them, and nothing is decided for the person.
 */

import type {
  GuestStatus,
  LiveGuest,
} from "@opensesame/app-core/lib/live/guest.js";
import { overlapCast } from "@opensesame/os-domain";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALLOW_ADDRESSES,
  JOIN_WITHOUT_ADDRESSES,
  ReplyAddresses,
} from "./LiveJoinAddresses.js";
import { standing } from "./LiveJoinStanding.js";

afterEach(cleanup);

function asked() {
  const answers: boolean[] = [];
  const answering: Pick<LiveGuest, "allowAddresses"> = {
    allowAddresses: async (allow) => {
      answers.push(allow);
      return true;
    },
  };
  // Only the one member the step calls.
  const guest: LiveGuest = overlapCast(answering);
  return { guest, answers };
}

const STATUS: Extract<GuestStatus, { at: "addresses" }> = {
  at: "addresses",
  addresses: ["100.64.0.7", "fd7a:115c:a1e0::7"],
};

describe("the owner's addresses", () => {
  it("shows each address and decides nothing until a key is pressed", () => {
    const { guest, answers } = asked();
    render(<ReplyAddresses guest={guest} status={STATUS} />);
    expect(screen.getByText("100.64.0.7")).toBeTruthy();
    expect(screen.getByText("fd7a:115c:a1e0::7")).toBeTruthy();
    expect(answers).toEqual([]);
  });

  it("allows them with the Allow key", () => {
    const { guest, answers } = asked();
    render(<ReplyAddresses guest={guest} status={STATUS} />);
    fireEvent.click(screen.getByRole("button", { name: ALLOW_ADDRESSES }));
    expect(answers).toEqual([true]);
  });

  it("joins without them from the other key", () => {
    const { guest, answers } = asked();
    render(<ReplyAddresses guest={guest} status={STATUS} />);
    fireEvent.click(
      screen.getByRole("button", { name: JOIN_WITHOUT_ADDRESSES }),
    );
    expect(answers).toEqual([false]);
  });

  it("is told on the status line while it waits", () => {
    expect(standing(STATUS)).toEqual({
      tone: "idle",
      label: "The owner's browser names its addresses",
      tray: "Allow the owner's addresses, or join without them",
    });
  });
});
