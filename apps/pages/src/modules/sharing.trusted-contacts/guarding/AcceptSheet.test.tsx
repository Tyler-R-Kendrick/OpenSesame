/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  Clock,
  type Device,
  device,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import {
  acceptGuardian,
  acceptInvitation,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import { expectPacket } from "@opensesame/app-core/lib/quorum/packets.js";
import { keyFingerprint } from "@opensesame/app-core/lib/quorum/request.js";
import { isJsonObject, isString } from "@opensesame/os-domain";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deskOf } from "../trusted-contacts.test-support.js";
import { AcceptSheet } from "./AcceptSheet.js";
import {
  captureCopies,
  dismissable,
  invitation,
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

/** The receiving key the desk sealed for this agreement: the one secret that must never be drawn. */
async function receivingKeyOf(guardian: Device): Promise<string> {
  const [key] = await guardian.pending.list("guardian-pending:");
  const doc = key === undefined ? undefined : await guardian.pending.read(key);
  if (isJsonObject(doc) && isString(doc.hpkeSecretKey))
    return doc.hpkeSecretKey;
  throw new Error("no agreement kept");
}

async function open(guardian: Device) {
  const onClose = vi.fn();
  const onAgreed = vi.fn();
  render(
    <AcceptSheet
      desk={await deskOf(guardian)}
      onAgreed={onAgreed}
      onClose={onClose}
    />,
  );
  return { onClose, onAgreed, user: userEvent.setup() };
}

/** Paste an invitation and read it, by keyboard from the sheet's close key. */
async function read(user: ReturnType<typeof userEvent.setup>, invite: string) {
  await user.tab();
  expect(document.activeElement).toBe(screen.getByLabelText("An invitation"));
  await user.paste(invite);
  await user.tab();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Read this invitation" }),
  );
  await user.keyboard("{Enter}");
}

describe("agreeing to guard a circle", () => {
  it("opens on the close key, and goes from the paste to the answer by keyboard alone", async () => {
    const clock = new Clock();
    const { owner, invite, circleId } = await invitation(clock);
    const guardian = device(clock);
    const { user, onAgreed } = await open(guardian);
    const closes = screen.getAllByRole("button", { name: "Close" });
    expect(document.activeElement).toBe(closes.at(-1));

    await read(user, invite);
    // The card says what is being agreed to, by what the invitation carries.
    const { ownerKey, origins } = expectPacket(invite, "invite").value;
    expect(await screen.findByText("Family")).toBeTruthy();
    expect(screen.getByText(keyFingerprint(ownerKey))).toBeTruthy();
    expect(screen.getByText(origins.join(", "))).toBeTruthy();
    // Focus followed the paste field out of the document, to the name.
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Your name")),
    );
    expect(
      screen
        .getByRole("switch", { name: "Add a backup key" })
        .getAttribute("aria-checked"),
    ).toBe("false");

    await user.keyboard("Ada{Enter}");
    const copy = await screen.findByRole(
      "button",
      { name: "Copy your answer" },
      { timeout: 5000 },
    );
    await waitFor(() => expect(document.activeElement).toBe(copy));
    expect(onAgreed).toHaveBeenCalledTimes(1);
    expect(screen.queryByLabelText("Your name")).toBeNull();
    expect(screen.queryByRole("button", { name: "Agree" })).toBeNull();

    await user.keyboard("{Enter}");
    await waitFor(() => expect(copied).toHaveLength(1));
    // What was copied is the owner's to take: a real enrollment that answers this invitation.
    const guardianEntry = await acceptGuardian(owner, circleId, {
      packet: copied[0] ?? "",
      custodyDomain: "home-Ada",
      contactRef: null,
    });
    expect(guardianEntry.name).toBe("Ada");
    expect(await guardian.pending.list("guardian-pending:")).toHaveLength(1);
  });

  it("registers a backup key when asked, and no more", async () => {
    const clock = new Clock();
    const { invite } = await invitation(clock);
    const guardian = device(clock, { keys: 2 });
    const { user } = await open(guardian);
    await read(user, invite);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Your name")),
    );
    await user.keyboard("Ben");
    await user.tab();
    const backup = screen.getByRole("switch", { name: "Add a backup key" });
    expect(document.activeElement).toBe(backup);
    await user.keyboard(" ");
    expect(backup.getAttribute("aria-checked")).toBe("true");
    await user.tab();
    await user.keyboard("{Enter}");
    await screen.findByRole(
      "button",
      { name: "Copy your answer" },
      { timeout: 5000 },
    );
    await user.keyboard("{Enter}");
    await waitFor(() => expect(copied).toHaveLength(1));
    const { credentials } = expectPacket(copied[0] ?? "", "enrollment").value;
    expect(credentials.map((key) => key.label)).toEqual([
      "Security key",
      "Backup key",
    ]);
  });

  it("offers no agreement on a page the circle does not accept, and says where to open it", async () => {
    const clock = new Clock();
    const { invite } = await invitation(clock);
    const guardian = device(clock, {
      origin: "https://elsewhere.example.test",
    });
    const { user } = await open(guardian);
    await read(user, invite);
    await screen.findByRole("img", {
      name: "Open this invitation at https://vault.example.test",
    });
    expect(screen.queryByRole("button", { name: "Agree" })).toBeNull();
    expect(screen.queryByLabelText("Your name")).toBeNull();
    // A wrong page is a fact about the card, not a failed step: nothing in the tray.
    expect(listNotices()).toEqual([]);
    // Nothing is left to press but the way out, and the keyboard is there.
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getAllByRole("button", { name: "Close" }).at(-1),
      ),
    );
    expect(await guardian.pending.list("guardian-pending:")).toEqual([]);
  });

  it("marks a key that was not touched on the card and in the tray, draws no text for it, and tries again", async () => {
    const clock = new Clock();
    const { invite } = await invitation(clock);
    const own = device(clock);
    const { person: guardian, allow } = dismissable(own);
    const { user } = await open(guardian);
    await read(user, invite);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Your name")),
    );
    await user.keyboard("Cy{Enter}");

    await screen.findByRole(
      "img",
      { name: "The security key was not used." },
      { timeout: 5000 },
    );
    const notice = listNotices().find(
      (one) => one.id === "trusted-contacts:guarding-agree",
    );
    expect(notice?.body).toBe("The security key was not used.");
    expect(notice?.title).toBe("Accept an invitation");
    expect(document.body.textContent).not.toContain("not used");
    // Enter was pressed in the name: the keyboard is still there, ready to try again.
    expect(document.activeElement).toBe(screen.getByLabelText("Your name"));
    expect(screen.getByRole("button", { name: "Agree" })).toBeTruthy();
    expect(await guardian.pending.list("guardian-pending:")).toEqual([]);

    allow();
    await user.keyboard("{Enter}");
    await screen.findByRole(
      "button",
      { name: "Copy your answer" },
      { timeout: 5000 },
    );
    expect(screen.queryByRole("img", { name: /security key/ })).toBeNull();
    expect(
      listNotices().some((one) => one.id === "trusted-contacts:guarding-agree"),
    ).toBe(false);
  });

  it("refuses a paste that is not an invitation on the field, before any key is pressed", async () => {
    const clock = new Clock();
    const { owner, invite } = await invitation(clock);
    const guardian = device(clock);
    const { user } = await open(guardian);
    await user.tab();
    const { enrollment } = await acceptInvitation(device(clock), {
      packet: invite,
      name: "Someone",
      keyLabels: ["Security key"],
    });
    await user.paste(enrollment);
    await screen.findByRole("img", {
      name: "This is an enrollment, not an invite.",
    });
    expect(
      screen.getByRole("button", { name: "Read this invitation" }),
    ).toHaveProperty("disabled", true);
    expect(listNotices()).toEqual([]);
    expect(await owner.records.owned()).toEqual([]);
  });

  it("draws and copies no secret: the receiving key stays in the sealed pending store", async () => {
    const clock = new Clock();
    const { invite } = await invitation(clock);
    const guardian = device(clock);
    const { user } = await open(guardian);
    await read(user, invite);
    await waitFor(() =>
      expect(document.activeElement).toBe(screen.getByLabelText("Your name")),
    );
    await user.keyboard("Ada{Enter}");
    await screen.findByRole(
      "button",
      { name: "Copy your answer" },
      { timeout: 5000 },
    );
    await user.keyboard("{Enter}");
    await waitFor(() => expect(copied).toHaveLength(1));
    const secret = await receivingKeyOf(guardian);
    expect(secret.length).toBeGreaterThan(20);
    expect(document.body.innerHTML).not.toContain(secret);
    expect(copied.join("")).not.toContain(secret);
    for (const key of document.querySelectorAll("[aria-label], [title]")) {
      expect(key.getAttribute("aria-label") ?? "").not.toContain(secret);
      expect(key.getAttribute("title") ?? "").not.toContain(secret);
    }
  });
});
