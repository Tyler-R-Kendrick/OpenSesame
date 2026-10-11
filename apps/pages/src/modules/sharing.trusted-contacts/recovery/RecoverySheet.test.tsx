/** @vitest-environment jsdom */
import { clearNotices, listNotices } from "@opensesame/app-core/lib/notices.js";
import {
  device,
  who,
} from "@opensesame/app-core/lib/quorum/desk/harness.test-support.js";
import {
  approveRequest,
  startRecoveryFlow,
} from "@opensesame/app-core/lib/quorum/desk/index.js";
import {
  decodePacket,
  encodePacket,
} from "@opensesame/app-core/lib/quorum/packets.js";
import { PAYLOAD } from "@opensesame/app-core/lib/quorum/world.test-support.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
import { fieldValue, isDisabled } from "../trusted-contacts.test-support.js";
import type { Desk } from "../use-desk.js";
import { RecoverySheet } from "./RecoverySheet.js";
import {
  AFTER_THE_DELAY,
  type Recovering,
  approvalOf,
  approvedBy,
  damaged,
  recipientSecret,
  recovering,
  releaseOf,
} from "./recovery.test-support.js";
import type { Recovered } from "./use-recovered.js";

const original = { ...vaultHooksSeams };
const SECRET = "correct horse battery staple";
let copied: string[];
let env: Recovering;

beforeEach(async () => {
  copied = [];
  Object.assign(vaultHooksSeams, {
    useCopySecret: () => async (value: string) => {
      copied.push(value);
      return "copied" as const;
    },
  });
  env = await recovering();
});

afterEach(() => {
  cleanup();
  clearNotices();
  Object.assign(vaultHooksSeams, original);
});

function open() {
  const desk: Desk = {
    ports: env.recipient,
    owned: [],
    held: [],
    refresh: async () => undefined,
  };
  const onChanged = vi.fn(async () => undefined);
  const onOpened = vi.fn(async (_item: Omit<Recovered, "safe">) => undefined);
  const onGaveUp = vi.fn(async () => undefined);
  const onClose = vi.fn();
  render(
    <RecoverySheet
      desk={desk}
      initial={env.started}
      onChanged={onChanged}
      onOpened={onOpened}
      onGaveUp={onGaveUp}
      onClose={onClose}
    />,
  );
  return { onChanged, onOpened, onGaveUp, onClose };
}

const box = () => screen.getByLabelText("An approval or a release");
const key = (name: string) => screen.getByRole("button", { name });
const closeKey = () => document.querySelector(".sheet__head .icon-btn");

/** Paste into the field, then Tab to its key and press Enter, as a person at a keyboard does. */
async function add(packet: string) {
  await userEvent.click(box());
  await userEvent.paste(packet);
  await userEvent.tab();
  expect(document.activeElement).toBe(key("Add"));
  await userEvent.keyboard("{Enter}");
  await waitFor(() => expect(fieldValue(box())).toBe(""));
}

/** The one line the sheet states about where the recovery stands. */
const stated = () => document.querySelector(".found__name")?.textContent ?? "";

/** Wait for that line to read `fact`. */
async function stands(fact: string) {
  await waitFor(() => expect(stated()).toBe(fact));
}

/** Add a packet and wait for the line to read `fact`. */
async function addAnd(packet: string, fact: string) {
  await add(packet);
  await stands(fact);
}

/** What the page says in text: a failure is never in it, only in a mark's label and the tray. */
function drawnNowhere(sentence: string) {
  expect(document.body.textContent).not.toContain(sentence);
}

describe("a recovery's sheet", () => {
  it("lands the keyboard on its close key, names the circle, and states where it stands in one line", async () => {
    open();
    await waitFor(() => expect(document.activeElement).toBe(closeKey()));
    expect(
      screen.getByRole("dialog", { name: "Family recovery" }),
    ).toBeTruthy();
    expect(stated()).toBe("0 of 2 approved");
    expect(
      screen.getByRole("img", { name: /^Collecting approvals until / }),
    ).toBeTruthy();
    // Nothing to open yet, nothing for the contacts to release with yet.
    expect(
      screen.queryByRole("button", { name: "Open the recovery" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Copy the approvals" }),
    ).toBeNull();
    expect(isDisabled(key("Add"))).toBe(true);
  });

  it("closes on Escape from the close key", async () => {
    const { onClose } = open();
    await waitFor(() => expect(document.activeElement).toBe(closeKey()));
    await userEvent.keyboard("{Escape}");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("goes from the request to approvals, the delay, releases and the open, by keyboard", async () => {
    const { onOpened, onChanged } = open();
    await waitFor(() => expect(document.activeElement).toBe(closeKey()));

    // The request is public: the whole of it goes on the clipboard, a glimpse on the page.
    await userEvent.click(key("Copy the request"));
    expect(copied).toEqual([env.started.request]);
    expect(document.body.textContent).not.toContain(env.started.request);

    await addAnd(await approvalOf(env, "Ada"), "1 of 2 approved");
    expect(
      screen.queryByRole("button", { name: "Copy the approvals" }),
    ).toBeNull();
    await add(await approvalOf(env, "Cy"));
    await waitFor(() => expect(stated()).toMatch(/^Waits until /));
    expect(screen.getByRole("img", { name: /^Releases open / })).toBeTruthy();
    expect(onChanged).toHaveBeenCalled();

    // Quorum: the approvals so far are what each contact needs to release.
    await userEvent.click(key("Copy the approvals"));
    const approvals = copied.at(-1) ?? "";
    const packet = decodePacket(approvals);
    expect(packet.kind).toBe("approvals");
    expect(packet.kind === "approvals" ? packet.value.length : 0).toBe(2);

    // The delay passes; the sheet reads the clock again when asked.
    env.clock.at(AFTER_THE_DELAY);
    await userEvent.click(key("Check the status"));
    await stands("0 of 2 shares released");
    expect(
      screen.getByRole("img", { name: /^Releases are open until / }),
    ).toBeTruthy();

    await addAnd(
      await releaseOf(env, "Ada", approvals),
      "1 of 2 shares released",
    );
    expect(
      screen.queryByRole("button", { name: "Open the recovery" }),
    ).toBeNull();
    await addAnd(
      await releaseOf(env, "Cy", approvals),
      "2 of 2 shares released",
    );
    expect(screen.getByRole("img", { name: "Complete" })).toBeTruthy();

    // Open by keyboard.
    const openKey = key("Open the recovery");
    openKey.focus();
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(onOpened).toHaveBeenCalledTimes(1));
    const item = onOpened.mock.calls[0]?.[0];
    expect(item?.label).toBe("Family");
    expect(item?.requestId).toBe(env.started.requestId);
    expect(JSON.parse(item?.text ?? "null")).toEqual(PAYLOAD);
  });

  it("says who a paste is from before anything is done with it", async () => {
    open();
    const approval = await approvalOf(env, "Ben");
    await userEvent.click(box());
    await userEvent.paste(approval);
    expect(await screen.findByText("An approval from Ben")).toBeTruthy();
    expect(isDisabled(key("Add"))).toBe(false);
    // The press is what acts.
    expect(stated()).toBe("0 of 2 approved");
  });

  it("marks a packet this field does not take on the field, with no notice", async () => {
    open();
    await userEvent.click(box());
    await userEvent.paste(env.started.request);
    await screen.findByRole("img", { name: /^This is a request, not / });
    expect(isDisabled(key("Add"))).toBe(true);
    expect(listNotices()).toEqual([]);
  });

  it("shows an answer the ledger refuses as a mark and a notice, clears the field, and leaves the standing alone", async () => {
    open();
    // An approval for some other recovery of the same circle.
    const other = await startRecoveryFlow(device(env.clock), {
      bundleText: env.bundleText,
      recipientLabel: "Someone else",
    });
    const stray = await approveRequest(who(env.armed, "Ada"), other.request);
    await add(stray);
    const notice = listNotices().find(
      (n) => n.id === "trusted-contacts:recovery-refused",
    );
    expect(notice?.title).toBe("Recovery");
    expect(notice?.body.length ?? 0).toBeGreaterThan(5);
    expect(
      await screen.findByRole("img", { name: notice?.body ?? "none" }),
    ).toBeTruthy();
    drawnNowhere(notice?.body ?? "none");
    expect(stated()).toBe("0 of 2 approved");
    // The next good answer takes the mark and the notice away.
    await addAnd(await approvalOf(env, "Ada"), "1 of 2 approved");
    expect(
      screen.queryByRole("img", { name: notice?.body ?? "none" }),
    ).toBeNull();
    expect(
      listNotices().some((n) => n.id === "trusted-contacts:recovery-refused"),
    ).toBe(false);
  });

  it("counts the answers in one paste that were accepted and marks the ones that were not", async () => {
    open();
    const other = await startRecoveryFlow(device(env.clock), {
      bundleText: env.bundleText,
      recipientLabel: "Someone else",
    });
    const good = decodePacket(await approvalOf(env, "Cy"));
    const stray = decodePacket(
      await approveRequest(who(env.armed, "Ada"), other.request),
    );
    if (good.kind !== "approval" || stray.kind !== "approval") {
      throw new Error("not approvals");
    }
    await add(
      encodePacket({ kind: "approvals", value: [good.value, stray.value] }),
    );
    await stands("1 of 2 approved");
    const notice = listNotices().find(
      (n) => n.id === "trusted-contacts:recovery-refused",
    );
    expect(notice).toBeTruthy();
    expect(
      screen.getAllByRole("img", { name: notice?.body ?? "none" }),
    ).toHaveLength(1);
  });

  it("names whom to ask again when a release does not open, and takes it back when a good one arrives", async () => {
    const approvals = await approvedBy(env, ["Ada", "Cy"]);
    const { onOpened } = open();
    await stands("0 of 2 shares released");
    await addAnd(
      damaged(await releaseOf(env, "Ada", approvals)),
      "1 of 2 shares released",
    );
    await addAnd(
      await releaseOf(env, "Cy", approvals),
      "2 of 2 shares released",
    );

    await userEvent.click(key("Open the recovery"));
    const failure = await screen.findByRole("img", {
      name: /^A release did not open as the share the owner committed to/,
    });
    expect(failure).toBeTruthy();
    expect(onOpened).not.toHaveBeenCalled();
    expect(
      listNotices().some((n) => n.id === "trusted-contacts:recovery-open"),
    ).toBe(true);
    // Whom to ask: a mark naming the action, the name beside it.
    expect(
      screen.getByRole("img", { name: "Ask Ada to release again" }),
    ).toBeTruthy();
    expect(screen.getByText("Ada")).toBeTruthy();
    // The dropped release counted off; there is nothing to open until Ada sends another.
    await stands("1 of 2 shares released");
    expect(
      screen.queryByRole("button", { name: "Open the recovery" }),
    ).toBeNull();
    drawnNowhere("did not open as the share");
    // The keyboard is not left on a key that went away.
    await waitFor(() => expect(document.activeElement).toBe(box()));

    await addAnd(
      await releaseOf(env, "Ada", approvals),
      "2 of 2 shares released",
    );
    expect(
      screen.queryByRole("img", { name: "Ask Ada to release again" }),
    ).toBeNull();
    expect(
      screen.queryByRole("img", { name: /^A release did not open/ }),
    ).toBeNull();
    await userEvent.click(key("Open the recovery"));
    await waitFor(() => expect(onOpened).toHaveBeenCalledTimes(1));
  });

  it("gives a recovery up only on a second press, with a key to keep it that hands the keyboard back", async () => {
    const { onGaveUp } = open();
    const giveUp = () => document.getElementById("recovery-give-up");
    giveUp()?.focus();
    await userEvent.keyboard("{Enter}");
    expect(giveUp()?.getAttribute("aria-label")).toBe(
      "Give up on this recovery for good",
    );
    expect(await env.recipient.pending.list("recovery:")).toHaveLength(1);
    expect(onGaveUp).not.toHaveBeenCalled();

    await userEvent.tab();
    expect(document.activeElement).toBe(key("Keep this recovery"));
    await userEvent.keyboard("{Enter}");
    expect(giveUp()?.getAttribute("aria-label")).toBe(
      "Give up on this recovery",
    );
    expect(document.activeElement).toBe(giveUp());
    expect(
      screen.queryByRole("button", { name: "Keep this recovery" }),
    ).toBeNull();

    await userEvent.keyboard("{Enter}");
    await userEvent.keyboard("{Enter}");
    await waitFor(() => expect(onGaveUp).toHaveBeenCalledTimes(1));
    expect(await env.recipient.pending.list("recovery:")).toEqual([]);
  });

  it("draws and copies nothing secret: no key of this device, no recovered item, no share", async () => {
    const secret = await recipientSecret(env.recipient, env.started.requestId);
    const approvals = await approvedBy(env, ["Ada", "Cy"]);
    const { onOpened } = open();
    await stands("0 of 2 shares released");
    await userEvent.click(key("Copy the request"));
    await userEvent.click(key("Copy the approvals"));
    await addAnd(
      await releaseOf(env, "Ada", approvals),
      "1 of 2 shares released",
    );
    await addAnd(
      await releaseOf(env, "Cy", approvals),
      "2 of 2 shares released",
    );
    await userEvent.click(key("Open the recovery"));
    await waitFor(() => expect(onOpened).toHaveBeenCalled());

    const page = document.body.innerHTML;
    expect(page).not.toContain(secret);
    expect(page).not.toContain(SECRET);
    // What reached the clipboard is packets, which are public by construction.
    expect(copied).toHaveLength(2);
    for (const text of copied) {
      expect(text.startsWith("osq1.")).toBe(true);
      expect(text).not.toContain(secret);
      expect(text).not.toContain(SECRET);
    }
    // The recovered document leaves in one place only: the text handed on.
    expect(onOpened.mock.calls[0]?.[0].text).toContain(SECRET);
  });

  it("reads where the recovery stands afresh when it opens, not as the list last had it", async () => {
    await approvedBy(env, ["Ada", "Cy"]);
    open();
    await stands("0 of 2 shares released");
    expect(
      screen.getByRole("button", { name: "Copy the approvals" }),
    ).toBeTruthy();
  });
});
