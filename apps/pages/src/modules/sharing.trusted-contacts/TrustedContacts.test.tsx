/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import { toB64url } from "@opensesame/app-core/lib/quorum/bytes.js";
import {
  Clock,
  armedCircle,
  device,
  who,
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
import { GuardingPanel } from "./GuardingPanel.js";
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
  it("every panel draws nothing at all: absent, not disabled", () => {
    serve(null);
    const { container } = render(<TrustedContacts />);
    expect(container.textContent).toBe("");
    expect(container.querySelector("section")).toBeNull();
    expect(screen.queryByRole("heading")).toBeNull();
  });
});

describe("with nothing yet", () => {
  it("shows an idle mark in each panel, not prose and not a tip", async () => {
    serve(await deskOf(device(new Clock())));
    render(<TrustedContacts />);
    const circles = within(elementById("circles"));
    const guarding = within(elementById("guarding"));
    expect(circles.getByRole("img", { name: "No circles yet." })).toBeTruthy();
    expect(
      guarding.getByRole("img", { name: "Nothing held for anyone yet." }),
    ).toBeTruthy();
    expect(
      await screen.findByRole("img", { name: "No recoveries in progress." }),
    ).toBeTruthy();
    expect(screen.queryAllByRole("listitem")).toEqual([]);
    expect(document.querySelectorAll("p")).toHaveLength(0);
  });
});

describe("the panels' frames", () => {
  it("are three sections the category's rail names, each with a heading and a polite line", async () => {
    serve(await deskOf(device(new Clock())));
    render(<TrustedContacts />);
    await screen.findByRole("img", { name: "No recoveries in progress." });
    const sections = [...document.querySelectorAll("section.panel")];
    expect(sections.map((s) => s.id)).toEqual([
      "circles",
      "guarding",
      "recovery",
    ]);
    expect(sections.map((s) => s.getAttribute("aria-label"))).toEqual([
      "Circles",
      "Guarding",
      "Recovery",
    ]);
    for (const section of sections) {
      expect(
        within(elementById(section.id)).getByRole("heading", { level: 2 }),
      ).toBeTruthy();
      const live = section.querySelector("output[aria-live=polite]");
      expect(live?.className).toBe("visually-hidden");
      // A panel's keys ride its head in one group, and no field sits open on the page.
      expect(section.querySelectorAll("fieldset").length).toBeLessThan(2);
      expect(section.querySelector("a, input, textarea")).toBeNull();
    }
  });

  it("are tutorial targets, found by the ids the walkthrough points at", async () => {
    serve(await deskOf(device(new Clock())));
    render(<TrustedContacts />);
    await screen.findByRole("img", { name: "No recoveries in progress." });
    for (const id of [
      "settings.trusted-contacts-circles",
      "settings.trusted-contacts-guarding",
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

describe("Guarding", () => {
  it("lists what a guardian holds: the circle, whose it is, share or seat, and its state", async () => {
    const armed = await armedCircle(new Clock());
    serve(await deskOf(who(armed, "Ada")));
    render(<GuardingPanel />);
    const row = screen
      .getByRole("heading", { level: 3, name: "Family" })
      .closest("li");
    if (!row) throw new Error("no row");
    expect(row.textContent).toMatch(
      /Held for [0-9a-f]{4}(-[0-9a-f]{4}){3} · share · epoch 1/,
    );
    expect(within(row).getByRole("img", { name: "Held" })).toBeTruthy();
    // The row's own keys are drawn (guarding/GuardingPanel.test.tsx walks them); no field is.
    expect(row.querySelector("a, input, textarea")).toBeNull();
    const [held] = await who(armed, "Ada").records.held();
    const wrapped = held?.holding?.wrapped;
    expect(wrapped).toBeDefined();
    expect(document.body.innerHTML).not.toContain(JSON.stringify(wrapped));
  });

  it("calls the seat of an approvals-only circle a seat", async () => {
    const armed = await armedCircle(new Clock(), { recovers: false });
    serve(await deskOf(who(armed, "Ben")));
    const { container } = render(<GuardingPanel />);
    expect(container.textContent).toContain(" · seat · epoch 1");
    expect(container.textContent).not.toContain(" · share · ");
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
    const notice = listNotices().find(
      (n) => n.id === "trusted-contacts:recoveries",
    );
    expect(notice?.title).toBe("Recovery");
  });
});
