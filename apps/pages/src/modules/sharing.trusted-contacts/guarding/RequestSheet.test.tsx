/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  Clock,
  type Device,
  device,
  who,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import {
  approvalsPacket,
  approveRequest,
  cancelRequest,
  ingest,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import {
  encodePacket,
  expectPacket,
} from "@opensesame/app-core/lib/quorum/packets.js";
import { keyFingerprint } from "@opensesame/app-core/lib/quorum/request.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deskOf } from "../trusted-contacts.test-support.js";
import { RequestSheet } from "./RequestSheet.js";
import {
  captureCopies,
  dismissable,
  recovering,
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
const SLOW = { timeout: 5000 };

async function open(guardian: Device, circleId: string | null = null) {
  const onClose = vi.fn();
  render(
    <RequestSheet
      desk={await deskOf(guardian)}
      circleId={circleId}
      onClose={onClose}
    />,
  );
  return { onClose, user: userEvent.setup() };
}

/** Paste into the sheet's field from the close key, and press its key. */
async function read(user: User, text: string, first = true) {
  if (first) await user.tab();
  else await user.click(screen.getByLabelText("A request"));
  expect(document.activeElement).toBe(screen.getByLabelText("A request"));
  await user.paste(text);
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Read this" }),
  );
  await user.keyboard("{Enter}");
}

describe("answering a request", () => {
  it("reads the request against the policy held, approves by keyboard, and ends on the approval to copy", async () => {
    const clock = new Clock();
    const { armed, recipient, started } = await recovering(clock);
    const ada = who(armed, "Ada");
    const { user } = await open(ada);
    expect(document.activeElement).toBe(
      screen.getAllByRole("button", { name: "Close" }).at(-1),
    );

    await read(user, started.request);
    // The sentence is the card's name: it is the thing being approved.
    expect(await screen.findByText(/^Release the recovery key/)).toBeTruthy();
    const { recipient: who_ } = expectPacket(started.request, "request").value;
    expect(screen.getByText(who_.label)).toBeTruthy();
    expect(screen.getByText(keyFingerprint(who_.hpkePublicKey))).toBeTruthy();
    expect(screen.getByRole("img", { name: "Open for approval" })).toBeTruthy();
    // Too early for a release: no field for one.
    expect(screen.queryByLabelText("The approvals so far")).toBeNull();

    // The paste field kept the keyboard; the next stop is the one key that acts.
    await user.tab();
    const approve = screen.getByRole("button", { name: "Approve" });
    expect(document.activeElement).toBe(approve);
    await user.keyboard("{Enter}");
    const copy = await screen.findByRole(
      "button",
      { name: "Copy your approval" },
      SLOW,
    );
    await waitFor(() => expect(document.activeElement).toBe(copy));
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();

    await user.keyboard("{Enter}");
    await waitFor(() => expect(copied).toHaveLength(1));
    // What was copied is a real approval: the recipient's ledger takes it.
    const taken = await ingest(recipient, started.requestId, copied[0] ?? "");
    expect(taken.outcomes).toEqual([{ ok: true }]);
    expect((await ada.records.held())[0]?.state).toBe("approved");
  });

  it("releases a share after the delay, by keyboard, from the approvals gathered so far", async () => {
    const clock = new Clock();
    const { armed, recipient, started } = await recovering(clock);
    for (const name of ["Ada", "Cy"]) {
      const approval = await approveRequest(who(armed, name), started.request);
      await ingest(recipient, started.requestId, approval);
    }
    clock.at(24 * 3600 + 1);
    const approvals = await approvalsPacket(recipient, started.requestId);
    const ada = who(armed, "Ada");
    const { user } = await open(ada);

    await read(user, started.request);
    expect(
      await screen.findByRole("img", { name: "Ready to release" }),
    ).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    const release = screen.getByRole("button", { name: "Release my share" });
    expect(release).toHaveProperty("disabled", true);

    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByLabelText("The approvals so far"),
    );
    await user.paste(approvals);
    await user.tab();
    expect(document.activeElement).toBe(release);
    await user.keyboard("{Enter}");
    const copy = await screen.findByRole(
      "button",
      { name: "Copy your release" },
      SLOW,
    );
    await waitFor(() => expect(document.activeElement).toBe(copy));
    await user.keyboard("{Enter}");
    await waitFor(() => expect(copied).toHaveLength(1));

    const taken = await ingest(recipient, started.requestId, copied[0] ?? "");
    expect(taken.outcomes).toEqual([{ ok: true }]);
    expect((await ada.records.held())[0]?.state).toBe("released");
  });

  it("changes the card when the owner's cancellation is pasted into the same field", async () => {
    const clock = new Clock();
    const { armed, started } = await recovering(clock);
    const { packet } = await cancelRequest(
      armed.owner,
      armed.circleId,
      started.request,
    );
    const { user } = await open(who(armed, "Ben"));
    await read(user, started.request);
    await screen.findByRole("img", { name: "Open for approval" });
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();

    await read(user, packet, false);
    await screen.findByRole("img", { name: "Cancelled by the owner" });
    expect(screen.queryByRole("img", { name: "Open for approval" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(listNotices()).toEqual([]);
  });

  it("notes a cancellation that arrives before the request, and the request then reads as cancelled", async () => {
    const clock = new Clock();
    const { armed, started } = await recovering(clock);
    const { packet } = await cancelRequest(
      armed.owner,
      armed.circleId,
      started.request,
    );
    const { user } = await open(who(armed, "Ben"));
    await read(user, packet);
    await screen.findByRole("img", { name: "Cancellation noted" });
    await read(user, started.request, false);
    await screen.findByRole("img", { name: "Cancelled by the owner" });
    expect(
      screen.queryByRole("img", { name: "Cancellation noted" }),
    ).toBeNull();
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("marks a key that was not touched on the card and in the tray, draws no text for it, and approves when tried again", async () => {
    const clock = new Clock();
    const { armed, recipient, started } = await recovering(clock);
    const ada = who(armed, "Ada");
    const { person, allow } = dismissable(ada);
    const { user } = await open(person);
    await read(user, started.request);
    await screen.findByRole("img", { name: "Open for approval" });
    await user.tab();
    await user.keyboard("{Enter}");

    await screen.findByRole(
      "img",
      { name: "The security key was not used." },
      SLOW,
    );
    const notice = listNotices().find(
      (one) => one.id === "trusted-contacts:guarding-approve",
    );
    expect(notice?.body).toBe("The security key was not used.");
    expect(notice?.title).toBe("Answer a request");
    expect(document.body.textContent).not.toContain("not used");
    // The key is enabled again and the keyboard is back on it.
    const approve = screen.getByRole("button", { name: "Approve" });
    await waitFor(() => expect(document.activeElement).toBe(approve));
    expect((await ada.records.held())[0]?.state).toBe("held");

    allow();
    await user.keyboard("{Enter}");
    await screen.findByRole("button", { name: "Copy your approval" }, SLOW);
    expect(screen.queryByRole("img", { name: /security key/ })).toBeNull();
    expect(
      listNotices().some(
        (one) => one.id === "trusted-contacts:guarding-approve",
      ),
    ).toBe(false);
    await user.keyboard("{Enter}");
    await waitFor(() => expect(copied).toHaveLength(1));
    expect(
      (await ingest(recipient, started.requestId, copied[0] ?? "")).outcomes,
    ).toEqual([{ ok: true }]);
  });

  it("refuses a request whose sentence does not describe it, with no card and a notice", async () => {
    const clock = new Clock();
    const { armed, started } = await recovering(clock);
    const real = expectPacket(started.request, "request").value;
    const lie = encodePacket({
      kind: "request",
      value: { ...real, summary: "Share a photo with the recipient" },
    });
    const { user } = await open(who(armed, "Ada"));
    await read(user, lie);
    await screen.findByRole("img", {
      name: "The sentence does not describe the request.",
    });
    expect(listNotices().map((one) => one.id)).toEqual([
      "trusted-contacts:guarding-request",
    ]);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    expect(document.body.textContent).not.toContain("Share a photo");
    expect(screen.getByLabelText("A request")).toHaveProperty("value", lie);
  });

  it("refuses a request for a circle this device holds nothing for", async () => {
    const clock = new Clock();
    const { started } = await recovering(clock);
    const { user } = await open(device(clock));
    await read(user, started.request);
    await screen.findByRole("img", {
      name: "This device holds nothing for that circle.",
    });
    expect(listNotices()).toHaveLength(1);
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
  });

  it("answers only for the circle it was opened on", async () => {
    const clock = new Clock();
    const { armed, started } = await recovering(clock);
    const other = await open(who(armed, "Ada"), "c-another-circle");
    await read(other.user, started.request);
    await screen.findByRole("img", {
      name: "This request is for another circle.",
    });
    expect(screen.queryByRole("button", { name: "Approve" })).toBeNull();
    cleanup();
    clearNotices();

    const own = await open(who(armed, "Ada"), armed.circleId);
    await read(own.user, started.request);
    await screen.findByRole("img", { name: "Open for approval" });
    expect(screen.getByRole("button", { name: "Approve" })).toBeTruthy();
    expect(listNotices()).toEqual([]);
  });
});
