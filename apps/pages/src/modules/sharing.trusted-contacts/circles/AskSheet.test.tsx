/** @vitest-environment jsdom */
import { listLocalShares } from "@opensesame/app-core/lib/local-share-grants.js";
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  Clock,
  armedCircle,
  who,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import type { Armed } from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import {
  DEFAULT_TIMING,
  approveRequest,
  askToShare,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import {
  decodePacket,
  encodePacket,
} from "@opensesame/app-core/lib/quorum/packets.js";
import { lockAllTombs } from "@opensesame/app-core/lib/vfs.js";
import {
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  deskOf,
  fieldValue,
  isDisabled,
} from "../trusted-contacts.test-support.js";
import { AskSheet } from "./AskSheet.js";
import {
  BANK_FOLDER,
  byId,
  openVaultWith,
  recordCopies,
  seedTomb,
  sheetKey,
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
  lockAllTombs();
  clearNotices();
});

async function circle(people: readonly string[] = ["Pat"]) {
  const clock = new Clock();
  const seeded = await seedTomb(people);
  const armed = await armedCircle(clock, {
    recovers: false,
    ownerTomb: seeded.tomb,
  });
  return { clock, armed, seeded };
}

async function open(armed: Armed, digest?: string) {
  const user = userEvent.setup();
  render(
    <AskSheet
      desk={await deskOf(armed.owner)}
      circleId={armed.circleId}
      digest={digest}
      onClose={() => undefined}
    />,
  );
  return { user };
}

const grant = (principalId: string) => ({
  principalId,
  resourceKind: "item" as const,
  resourceId: "bank-login",
  resourceLabel: "Bank login",
  policy: "read",
  durationSeconds: 3600,
});

describe("asking the circle", () => {
  it("offers the people of the directory, what the vault holds, and the ledger's own policies and durations", async () => {
    const { armed } = await circle(["Pat", "Quinn"]);
    await open(armed);
    const person = await screen.findByLabelText("Person");
    await screen.findByRole("option", { name: "Quinn" });
    expect(
      within(person)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Pat", "Quinn"]);
    const item = screen.getByLabelText("Item");
    expect(
      within(item)
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual(["Router", "Banking / Savings"]);
    const policy = screen.getByRole("radiogroup", { name: "Policy" });
    expect(
      within(policy)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Read", "Use"]);
    expect(
      within(policy)
        .getByRole("button", { name: "Read" })
        .getAttribute("aria-pressed"),
    ).toBe("true");
    const duration = screen.getByRole("radiogroup", { name: "Duration" });
    expect(
      within(duration)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["1 hour", "8 hours", "1 day", "1 week"]);
    // A folder is another kind of thing to ask about, with its own list.
    await userEvent.click(screen.getByRole("button", { name: "Folder" }));
    expect(
      within(screen.getByLabelText("Folder"))
        .getAllByRole("option")
        .map((o) => o.textContent),
    ).toEqual([BANK_FOLDER.name]);
    expect(isDisabled(sheetKey("Ask the circle"))).toBe(false);
  });

  it("says when there is nobody to ask about, or nothing to ask about, and waits", async () => {
    const { armed } = await circle([]);
    restores.push(openVaultWith([], []));
    await open(armed);
    expect(
      await screen.findByRole("img", { name: "No people in the directory." }),
    ).toBeTruthy();
    expect(
      screen.getByRole("img", { name: "No items in this vault." }),
    ).toBeTruthy();
    expect(isDisabled(sheetKey("Ask the circle"))).toBe(true);
  });

  it("goes from a request to a written share, by keyboard, once enough have approved and the delay has passed", async () => {
    const { armed, clock, seeded } = await circle();
    const { user } = await open(armed);
    await screen.findByRole("option", { name: "Pat" });
    await user.selectOptions(
      screen.getByLabelText("Item"),
      "Banking / Savings",
    );
    await user.click(screen.getByRole("button", { name: "Use" }));
    await user.click(screen.getByRole("button", { name: "1 day" }));
    await tabTo(
      user,
      (e) => e.getAttribute("aria-label") === "Ask the circle",
      "the Ask key",
    );
    await user.keyboard("{Enter}");

    // The request, to hand on; nothing is approved yet.
    await screen.findByRole("button", { name: "Copy request" });
    expect(screen.getByText("0 of 3 approved")).toBeTruthy();
    expect(screen.getByText("Banking / Savings · use")).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Copy request" }));
    const request = copies.at(-1) ?? "";
    expect(request.startsWith("osq1.request.")).toBe(true);
    expect(isDisabled(sheetKey("Add approvals"))).toBe(true);
    expect(screen.queryByRole("button", { name: "Share it" })).toBeNull();

    for (const name of ["Ada", "Cy"]) {
      const approval = await approveRequest(who(armed, name), request);
      await tabTo(user, byId("tcc-approvals"), "the approvals field");
      await user.paste(approval);
      await user.click(sheetKey("Add approvals"));
      await waitFor(() =>
        expect(fieldValue(screen.getByLabelText("Approvals"))).toBe(""),
      );
    }
    expect(screen.getByText(/^2 of 3 approved · waits until /)).toBeTruthy();
    expect(screen.getByRole("img", { name: /^Waits until / })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Share it" })).toBeNull();
    expect(await listLocalShares(seeded.tomb)).toHaveLength(0);

    // The delay passes; the key reads the request again.
    clock.at(DEFAULT_TIMING.releaseDelaySec + 1);
    await user.click(
      screen.getByRole("button", { name: "Check this request again" }),
    );
    const share = await screen.findByRole("button", { name: "Share it" });
    expect(screen.getByRole("img", { name: /^Approved until / })).toBeTruthy();
    await user.click(share);
    await screen.findByRole("img", { name: "Shared" });
    expect(screen.queryByRole("button", { name: "Share it" })).toBeNull();
    expect(screen.queryByLabelText("Approvals")).toBeNull();
    const written = await listLocalShares(seeded.tomb);
    expect(written).toHaveLength(1);
    expect(written[0]).toMatchObject({
      principalId: seeded.people[0]?.id,
      resourceKind: "item",
      resourceLabel: "Banking / Savings",
      policy: "use",
    });
    expect(listNotices()).toEqual([]);
  }, 30_000);

  it("refuses an approval it has already counted, on the field and in the tray, and keeps the paste", async () => {
    const { armed, seeded } = await circle();
    const asked = await askToShare(
      armed.owner,
      armed.circleId,
      grant(seeded.people[0]?.id ?? ""),
    );
    const { user } = await open(armed, asked.digest);
    await screen.findByLabelText("Approvals");
    const approval = await approveRequest(who(armed, "Ada"), asked.packet);
    await user.click(screen.getByLabelText("Approvals"));
    await user.paste(approval);
    await user.click(sheetKey("Add approvals"));
    await screen.findByText("1 of 3 approved");

    await user.click(screen.getByLabelText("Approvals"));
    await user.paste(approval);
    await user.click(sheetKey("Add approvals"));
    const refusal = await screen.findAllByRole("img", { name: /./ });
    expect(refusal.length).toBeGreaterThan(0);
    await waitFor(() =>
      expect(
        listNotices().some((n) => n.id === "trusted-contacts:tcc-approvals"),
      ).toBe(true),
    );
    expect(fieldValue(screen.getByLabelText("Approvals"))).toBe(approval);
    expect(screen.getByText("1 of 3 approved")).toBeTruthy();
  });

  it("counts the approvals of a list that are good and tells which was not", async () => {
    const { armed, seeded } = await circle();
    const asked = await askToShare(
      armed.owner,
      armed.circleId,
      grant(seeded.people[0]?.id ?? ""),
    );
    const { user } = await open(armed, asked.digest);
    await screen.findByLabelText("Approvals");
    const one = decodePacket(
      await approveRequest(who(armed, "Ada"), asked.packet),
    );
    if (one.kind !== "approval") throw new Error("not an approval");
    const list = encodePacket({
      kind: "approvals",
      value: [one.value, one.value],
    });
    await user.click(screen.getByLabelText("Approvals"));
    await user.paste(list);
    await user.click(sheetKey("Add approvals"));
    await screen.findByText("1 of 3 approved");
    await waitFor(() =>
      expect(
        listNotices().some((n) => n.id === "trusted-contacts:ask-refused"),
      ).toBe(true),
    );
    // The paste was taken: what was good is counted.
    expect(fieldValue(screen.getByLabelText("Approvals"))).toBe("");
  });

  it("takes a request back up where it stands after a reload", async () => {
    const { armed, seeded } = await circle();
    const asked = await askToShare(
      armed.owner,
      armed.circleId,
      grant(seeded.people[0]?.id ?? ""),
    );
    await open(armed, asked.digest);
    expect(await screen.findByText("0 of 3 approved")).toBeTruthy();
    expect(screen.getByText("Bank login · read")).toBeTruthy();
    expect(screen.queryByLabelText("Person")).toBeNull();
  });

  it("shows the wrong kind of packet at once and without a notice", async () => {
    const { armed, seeded } = await circle();
    const asked = await askToShare(
      armed.owner,
      armed.circleId,
      grant(seeded.people[0]?.id ?? ""),
    );
    const { user } = await open(armed, asked.digest);
    await user.click(await screen.findByLabelText("Approvals"));
    await user.paste(asked.packet);
    expect(
      await screen.findByRole("img", {
        name: /^This is a request, not an approval/,
      }),
    ).toBeTruthy();
    expect(isDisabled(sheetKey("Add approvals"))).toBe(true);
    expect(listNotices()).toEqual([]);
  });
});
