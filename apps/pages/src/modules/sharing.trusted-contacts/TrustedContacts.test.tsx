/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { toB64url } from "@opensesame/app-core/lib/quorum/bytes.js";
import {
  Clock,
  armedCircle,
  device,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import {
  DeskError,
  type DeskPorts,
  startRecoveryFlow,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { CirclesPanel } from "./CirclesPanel.js";
import { RecoveryPanel } from "./RecoveryPanel.js";
import { TrustedContacts } from "./TrustedContacts.js";
import {
  declareTargets,
  deskOf,
  elementById,
  serveDesk,
} from "./trusted-contacts.test-support.js";

let undeclare: () => void;
let unserve: () => void = () => undefined;

beforeEach(() => {
  undeclare = declareTargets();
});

afterEach(() => {
  cleanup();
  unserve();
  undeclare();
  clearNotices();
});

function serve(desk: Awaited<ReturnType<typeof deskOf>> | null) {
  unserve();
  unserve = serveDesk(desk);
}

describe("while there is no desk (locked, a guest, a decoy)", () => {
  it("says why instead of drawing a blank category", () => {
    serve(null);
    render(<TrustedContacts />);
    expect(
      screen.getByRole("heading", { name: "Trusted contacts", level: 2 }),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", {
        name: /unlocked owner vault/,
      }),
    ).toBeTruthy();
  });
});

describe("with nothing yet", () => {
  it("shows an idle mark in each panel, not prose and not a tip", async () => {
    serve(await deskOf(device(new Clock())));
    render(<TrustedContacts />);
    const circles = within(elementById("circles"));
    expect(circles.getByRole("img", { name: "No circles yet." })).toBeTruthy();
    expect(
      circles.queryByRole("button", { name: "Start your first circle" }),
    ).toBeNull();
    expect(
      await screen.findByRole("img", { name: "No recoveries in progress." }),
    ).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toEqual([]);
    expect(document.querySelectorAll("p")).toHaveLength(0);
  });
});

describe("the panels' frames", () => {
  it("is one Security panel with two titled groups and a polite line each", async () => {
    serve(await deskOf(device(new Clock())));
    render(<TrustedContacts />);
    await screen.findByRole("img", { name: "No recoveries in progress." });
    const section = document.querySelector("section#trusted-contacts");
    expect(section?.className).toContain("set__security");
    expect(
      within(section as HTMLElement).getByRole("heading", {
        level: 2,
        name: "Trusted contacts",
      }),
    ).toBeTruthy();
    const groups = [...document.querySelectorAll(".trusted-contacts__group")];
    expect(groups.map((group) => group.id)).toEqual(["circles", "recovery"]);
    expect(groups.map((group) => group.getAttribute("aria-label"))).toEqual([
      "Circles",
      "Recovery",
    ]);
    for (const group of groups) {
      expect(
        within(group as HTMLElement).getByRole("heading", { level: 3 }),
      ).toBeTruthy();
      const live = group.querySelector("output[aria-live=polite]");
      expect(live?.className).toBe("visually-hidden");
      expect(group.querySelectorAll("fieldset").length).toBe(1);
      expect(group.querySelector("a, input, textarea")).toBeNull();
    }
  });

  it("are tutorial targets, found by the ids the walkthrough points at", async () => {
    serve(await deskOf(device(new Clock())));
    render(<TrustedContacts />);
    await screen.findByRole("img", { name: "No recoveries in progress." });
    for (const id of [
      "settings.trusted-contacts-circles",
      "settings.trusted-contacts-recovery",
    ]) {
      expect(
        document.querySelector(`[data-guide-target="${id}"]`),
      ).not.toBeNull();
    }
  });
});

describe("Circles", () => {
  it("lists a circle the owner keeps: its name, rule, epoch, contacts and where it stands", async () => {
    const armed = await armedCircle(new Clock());
    serve(await deskOf(armed.owner));
    render(<CirclesPanel />);
    const row = screen
      .getByRole("heading", { level: 3, name: "Family" })
      .closest("li");
    if (!row) throw new Error("no row");
    expect(row.textContent).toContain("2 of 3 · epoch 1 · 3 contacts");
    expect(within(row).getByRole("img", { name: /^Armed/ })).toBeTruthy();
    // The row's one key opens the circle (circles/ walks the sheets); no field is drawn.
    expect(
      within(row).getByRole("button", { name: "Open Family" }),
    ).toBeTruthy();
    expect(row.querySelector("a, input, textarea")).toBeNull();
    expect(screen.queryByRole("img", { name: "No circles yet." })).toBeNull();
  });

  it("says an approvals-only circle is one, and keeps the owner key off the page", async () => {
    const armed = await armedCircle(new Clock(), { recovers: false });
    serve(await deskOf(armed.owner));
    const { container } = render(<CirclesPanel />);
    expect(container.textContent).toContain("approvals only");
    const [owned] = await armed.owner.records.owned();
    if (!owned) throw new Error("no circle");
    expect(container.innerHTML).not.toContain(toB64url(owned.ownerSecretKey));
  });

  it("tells a screen reader the count only when it changes", async () => {
    const armed = await armedCircle(new Clock());
    const desk = await deskOf(armed.owner);
    serve(desk);
    const { rerender } = render(<CirclesPanel />);
    const live = () => document.querySelector("output")?.textContent;
    expect(live()).toBe("");
    serve({ ...desk, owned: [] });
    rerender(<CirclesPanel />);
    await waitFor(() => expect(live()).toBe("No circles"));
    serve(desk);
    rerender(<CirclesPanel />);
    await waitFor(() => expect(live()).toBe("1 circle"));
  });
});

describe("Recovery", () => {
  async function recovering() {
    const clock = new Clock();
    const armed = await armedCircle(clock);
    const recipient = device(clock);
    const started = await startRecoveryFlow(recipient, {
      bundleText: armed.dealt.bundleFile ?? "",
      recipientLabel: "New laptop",
    });
    return { recipient, started };
  }

  it("lists a recovery in flight with its counts and where the ledger stands", async () => {
    const { recipient } = await recovering();
    serve(await deskOf(recipient));
    render(<RecoveryPanel />);
    const row = (
      await screen.findByRole("heading", { level: 3, name: "Family" })
    ).closest("li");
    if (!row) throw new Error("no row");
    expect(row.textContent).toContain("0 approved · 0 released");
    expect(
      within(row).getByRole("img", { name: /^Collecting approvals until / }),
    ).toBeTruthy();
    // The row's one key opens its sheet (recovery/ walks it); no field is drawn.
    expect(
      within(row).getByRole("button", { name: "Open Family recovery" }),
    ).toBeTruthy();
    expect(row.querySelector("a, input, textarea")).toBeNull();
  });

  it("reads again when the desk is refreshed", async () => {
    const { recipient, started } = await recovering();
    const desk = await deskOf(recipient);
    serve(desk);
    const { rerender } = render(<RecoveryPanel />);
    await screen.findByRole("heading", { level: 3, name: "Family" });
    // The recovery ends on this device; the next desk no longer lists it.
    await recipient.pending.remove(`recovery:${started.requestId}`);
    serve({ ...desk });
    rerender(<RecoveryPanel />);
    await screen.findByRole("img", { name: "No recoveries in progress." });
  });

  it("marks a read that failed on the panel and once in the tray", async () => {
    const { recipient } = await recovering();
    const ports: DeskPorts = {
      ...recipient,
      pending: {
        ...recipient.pending,
        list: async () => {
          throw new DeskError("sealed", "the recoveries could not be opened");
        },
      },
    };
    serve({ ...(await deskOf(recipient)), ports });
    render(<RecoveryPanel />);
    await screen.findByRole("img", {
      name: "The recoveries could not be opened.",
    });
    // The tray notice is raised in an effect a tick after the mark is drawn.
    await waitFor(() =>
      expect(
        listNotices().find((n) => n.id === "trusted-contacts:recoveries")
          ?.title,
      ).toBe("Recovery"),
    );
  });
});
