/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  Clock,
  type Device,
  device,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import {
  DeskError,
  acceptInvitation,
  beginCircle,
  listAgreements,
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
import { GuardingPanel } from "../GuardingPanel.js";
import {
  declareTargets,
  elementById,
  serveDesk,
} from "../trusted-contacts.test-support.js";
import type { Desk } from "../use-desk.js";
import {
  WAITING,
  agreedGuardian,
  captureCopies,
  liveDesk,
  restoreCopies,
} from "./guarding.test-support.js";

let undeclare: () => void;
let unserve: () => void = () => undefined;

beforeEach(() => {
  undeclare = declareTargets();
  captureCopies();
});

afterEach(() => {
  cleanup();
  unserve();
  undeclare();
  clearNotices();
  restoreCopies();
});

function serve(desk: Desk) {
  unserve();
  unserve = serveDesk(desk);
}

/** A guardian who has agreed to Family's invitation and been answered by nobody, shown to the panel. */
async function waiting() {
  const agreed = await agreedGuardian();
  serve(await liveDesk(agreed.guardian));
  return agreed;
}

describe("forgetting an invitation", () => {
  it("takes two presses: the first names what is lost and offers a keep key, the second does it, and the keyboard lands on the head", async () => {
    const { guardian } = await waiting();
    render(<GuardingPanel />);
    const user = userEvent.setup();
    const forget = await screen.findByRole("button", {
      name: "Forget the invitation to Family",
    });
    forget.focus();
    await user.keyboard("{Enter}");

    // Armed: ink, not red; the keep key is beside it; nothing is gone yet.
    const armed = screen.getByRole("button", {
      name: "Forget the invitation to Family for good",
    });
    expect(armed.className).toContain("is-armed");
    expect(armed.className).not.toContain("danger");
    expect(document.activeElement).toBe(armed);
    const keep = screen.getByRole("button", {
      name: "Keep the invitation to Family",
    });
    expect(keep.className).not.toContain("danger");
    expect(await guardian.pending.list("guardian-pending:")).toHaveLength(1);

    await user.keyboard("{Enter}");
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { level: 3, name: "Family" }),
      ).toBeNull(),
    );
    expect(await guardian.pending.list("guardian-pending:")).toEqual([]);
    expect(
      await screen.findByRole("img", { name: "Nothing held for anyone yet." }),
    ).toBeTruthy();
    await waitFor(() =>
      expect(document.activeElement).toBe(elementById("guarding-accept")),
    );
    expect(listNotices()).toEqual([]);
  });

  it("keeps the invitation when the keep key is pressed, and hands the keyboard back to the first key", async () => {
    const { guardian } = await waiting();
    render(<GuardingPanel />);
    const user = userEvent.setup();
    const forget = await screen.findByRole("button", {
      name: "Forget the invitation to Family",
    });
    forget.focus();
    await user.keyboard("{Enter}");
    await user.tab();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Keep the invitation to Family" }),
    );
    await user.keyboard("{Enter}");

    const again = screen.getByRole("button", {
      name: "Forget the invitation to Family",
    });
    expect(document.activeElement).toBe(again);
    expect(again.className).not.toContain("is-armed");
    expect(
      screen.queryByRole("button", { name: "Keep the invitation to Family" }),
    ).toBeNull();
    expect(await guardian.pending.list("guardian-pending:")).toHaveLength(1);
    expect(screen.getByRole("img", { name: WAITING })).toBeTruthy();
  });

  it("forgets only the one it is on", async () => {
    const clock = new Clock();
    const guardian = device(clock);
    for (const label of ["Family", "Work"]) {
      const { invite } = await beginCircle(device(clock), {
        label,
        collection: "Things",
        recovers: false,
      });
      await acceptInvitation(guardian, {
        packet: invite,
        name: "Ada",
        keyLabels: ["Security key"],
      });
    }
    serve(await liveDesk(guardian));
    render(<GuardingPanel />);
    const user = userEvent.setup();
    const key = await screen.findByRole("button", {
      name: "Forget the invitation to Work",
    });
    key.focus();
    await user.keyboard("{Enter}{Enter}");
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { level: 3, name: "Work" }),
      ).toBeNull(),
    );
    expect(
      screen.getByRole("heading", { level: 3, name: "Family" }),
    ).toBeTruthy();
    expect(
      (await listAgreements(guardian)).map((one) => one.circleLabel),
    ).toEqual(["Family"]);
  });

  it("marks a refusal in the tray when the invitation was already gone, and reads the list as it is", async () => {
    const { guardian } = await waiting();
    render(<GuardingPanel />);
    const user = userEvent.setup();
    const forget = await screen.findByRole("button", {
      name: "Forget the invitation to Family",
    });
    // Another tab forgot it first.
    const [key] = await guardian.pending.list("guardian-pending:");
    await guardian.pending.remove(key ?? "");
    forget.focus();
    await user.keyboard("{Enter}{Enter}");

    await waitFor(() =>
      expect(
        listNotices().some(
          (one) => one.id === "trusted-contacts:guarding-forget",
        ),
      ).toBe(true),
    );
    const notice = listNotices().find(
      (one) => one.id === "trusted-contacts:guarding-forget",
    );
    expect(notice?.id).toBe("trusted-contacts:guarding-forget");
    expect(notice?.title).toBe("Forget an invitation");
    expect(notice?.body).toBe("This device has not accepted that invitation.");
    expect(document.body.textContent).not.toContain("not accepted");
    // The row went with the list being read again, and the keyboard did not fall to the page.
    await waitFor(() =>
      expect(
        screen.queryByRole("heading", { level: 3, name: "Family" }),
      ).toBeNull(),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(elementById("guarding-accept")),
    );
  });
});

describe("an invitation that cannot be forgotten", () => {
  it("keeps its row with a mark and a notice, disarms the key, and leaves the keyboard where it was", async () => {
    const { guardian } = await waiting();
    const broken: Device = {
      ...guardian,
      pending: {
        ...guardian.pending,
        remove: async () => {
          throw new DeskError("sealed", "the invitation is sealed");
        },
      },
    };
    serve(await liveDesk(broken));
    render(<GuardingPanel />);
    const user = userEvent.setup();
    const forget = await screen.findByRole("button", {
      name: "Forget the invitation to Family",
    });
    forget.focus();
    await user.keyboard("{Enter}{Enter}");

    const row = screen
      .getByRole("heading", { level: 3, name: "Family" })
      .closest("li");
    if (!row) throw new Error("no row");
    expect(
      await within(row).findByRole("img", {
        name: "The invitation is sealed.",
      }),
    ).toBeTruthy();
    expect(
      listNotices().find((one) => one.id === "trusted-contacts:guarding-forget")
        ?.body,
    ).toBe("The invitation is sealed.");
    expect(document.body.textContent).not.toContain("is sealed");
    // Disarmed, and still the key the keyboard is on.
    const again = within(row).getByRole("button", {
      name: "Forget the invitation to Family",
    });
    expect(again.className).not.toContain("is-armed");
    expect(document.activeElement).toBe(again);
    expect(await guardian.pending.list("guardian-pending:")).toHaveLength(1);
  });
});
