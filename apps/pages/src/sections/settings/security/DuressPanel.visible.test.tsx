/** @vitest-environment jsdom */
import { duressStatus } from "@opensesame/app-core/lib/duress/settings/device-duress.js";
import { VISIBLE_ITEMS } from "@opensesame/app-core/lib/duress/settings/modes/visible-items.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { createItem } from "@opensesame/vault-core";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withPassword } from "../../vault/account.test-support.js";
import { DuressPanel } from "./DuressPanel.js";
import {
  SEALING,
  arm,
  resetDevice,
  typeCode,
} from "./DuressPanel.test-support.js";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const MODE = VISIBLE_ITEMS.label;
const go = () => screen.getByRole("button", { name: "Turn on duress code" });
const tick = (): HTMLInputElement => {
  const box = screen.getByRole("checkbox");
  if (!(box instanceof HTMLInputElement)) throw new Error("not a checkbox");
  return box;
};
const hideSwitch = (name: string) =>
  screen.getByRole("switch", { name: `Hide ${name}` });
const switches = () => screen.queryAllByRole("switch");

/** One write, so the vault is settled before the sheet opens. */
async function seed() {
  await vaultStore.createWithPin("48291037");
  await vaultStore.addItems([
    withPassword(createItem("account", "Netflix"), "netflix-pw-4417"),
    withPassword(createItem("account", "Hidden Bank"), "hidden-pw-Zq91-xk"),
    {
      ...createItem("note", "Gym code"),
      notes: "locker combination 5520",
    },
    createItem("passkey", "A passkey"),
    {
      ...createItem("account", "Old trashed"),
      deletedAt: new Date().toISOString(),
    },
  ]);
  await vaultStore.flushPendingWrites();
}

async function openMode() {
  await userEvent.click(screen.getByRole("button", { name: "Add" }));
  await userEvent.click(screen.getByRole("radio", { name: MODE }));
}

describe("DuressPanel, show my vault without the items I hide", () => {
  beforeEach(async () => {
    await resetDevice();
  });
  afterEach(async () => {
    cleanup();
    // The seeded writes are still on their way; a destroy that does not wait
    // for them lets the next test's vault meet this one's files.
    await vaultStore.flushPendingWrites();
    await resetDevice();
    vaultStore.lock();
    await vaultStore.destroy();
  });

  it("is absent, not disabled, when the open vault has nothing it can show", async () => {
    await vaultStore.createWithPin("48291037");
    await vaultStore.addItems([createItem("passkey", "A passkey")]);
    await vaultStore.flushPendingWrites();
    render(<DuressPanel arm={arm} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.queryByRole("radio", { name: MODE })).toBeNull();
    expect(screen.queryByText(MODE)).toBeNull();
    // The other modes are drawn as ever.
    expect(screen.getByRole("radio", { name: "Decoy vault" })).toBeTruthy();
  });

  it("is offered after the decoys and before the refusals when there are items", async () => {
    await seed();
    render(<DuressPanel arm={arm} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    const names = screen
      .getAllByRole("radio")
      .map((radio) => radio.closest("label")?.textContent);
    const at = names.indexOf(MODE);
    expect(at).toBeGreaterThan(names.indexOf("Decoy vault"));
    for (const refusal of ["Wrong password", "Freeze for a while"]) {
      expect(names.indexOf(refusal)).toBeGreaterThan(at);
    }
  });

  it("lists the shareable items as switches, every one hidden, with no secret on screen", async () => {
    await seed();
    render(<DuressPanel arm={arm} />);
    await openMode();
    expect(switches().map((node) => node.getAttribute("aria-label"))).toEqual([
      "Hide Netflix",
      "Hide Hidden Bank",
      "Hide Gym code",
    ]);
    for (const node of switches()) {
      expect(node.getAttribute("aria-checked")).toBe("true");
    }
    // Names and kinds, never a secret; passkeys and the trash are not offered.
    const text = document.body.textContent ?? "";
    for (const secret of [
      "netflix-pw-4417",
      "hidden-pw-Zq91-xk",
      "locker combination 5520",
    ]) {
      expect(text).not.toContain(secret);
    }
    expect(text).not.toContain("A passkey");
    expect(text).not.toContain("Old trashed");
    expect(text).toContain("0 of 3 shown");
    expect(screen.getByText(VISIBLE_ITEMS.opens)).toBeTruthy();
    expect(screen.getByText(VISIBLE_ITEMS.consent)).toBeTruthy();
  });

  it("keeps arming off until at least one item is shown, the code and this mode's consent", async () => {
    await seed();
    render(<DuressPanel arm={arm} />);
    await openMode();
    await typeCode("739104628");
    await userEvent.click(tick());
    // Everything hidden: nothing to show, so nothing to arm.
    expect(go().hasAttribute("disabled")).toBe(true);
    await userEvent.click(hideSwitch("Netflix"));
    expect(hideSwitch("Netflix").getAttribute("aria-checked")).toBe("false");
    expect(screen.getByText(/1 of 3 shown/)).toBeTruthy();
    expect(go().hasAttribute("disabled")).toBe(false);
    await userEvent.click(hideSwitch("Netflix"));
    expect(go().hasAttribute("disabled")).toBe(true);
  });

  it("is a switch the keyboard owns: Space and Enter toggle it, and Tab moves on", async () => {
    await seed();
    render(<DuressPanel arm={arm} />);
    await openMode();
    const first = hideSwitch("Netflix");
    first.focus();
    await userEvent.keyboard(" ");
    expect(first.getAttribute("aria-checked")).toBe("false");
    await userEvent.keyboard("{Enter}");
    expect(first.getAttribute("aria-checked")).toBe("true");
    await userEvent.tab();
    expect(document.activeElement).toBe(hideSwitch("Hidden Bank"));
  });

  it("toggles from the name as well as the track: the whole row is the switch", async () => {
    await seed();
    render(<DuressPanel arm={arm} />);
    await openMode();
    await userEvent.click(screen.getByText("Gym code"));
    expect(hideSwitch("Gym code").getAttribute("aria-checked")).toBe("false");
  });

  it("starts every item hidden again when the mode is picked afresh", async () => {
    await seed();
    render(<DuressPanel arm={arm} />);
    await openMode();
    await userEvent.click(hideSwitch("Netflix"));
    await userEvent.click(screen.getByRole("radio", { name: "Decoy vault" }));
    expect(switches()).toHaveLength(0);
    await userEvent.click(screen.getByRole("radio", { name: MODE }));
    expect(hideSwitch("Netflix").getAttribute("aria-checked")).toBe("true");
  });

  it("hands arming the open vault's items and the ids left shown, and nothing else", async () => {
    await seed();
    const spy = vi.fn(arm);
    render(<DuressPanel arm={spy} />);
    await openMode();
    await userEvent.click(hideSwitch("Gym code"));
    await userEvent.click(hideSwitch("Netflix"));
    await typeCode("739104628");
    await userEvent.click(tick());
    await userEvent.click(go());
    await waitFor(() => expect(spy).toHaveBeenCalledOnce(), SEALING);
    const call = spy.mock.calls[0]?.[0];
    const byName = new Map(
      (call?.items ?? []).map((item) => [item.name, item.id]),
    );
    expect(call?.mode).toBe("visible_items");
    // In the vault's order, the ids of exactly the two left shown.
    expect(call?.extras).toEqual({
      shown: [byName.get("Netflix"), byName.get("Gym code")].join("\n"),
    });
    await screen.findByText("Duress code is on.", {}, SEALING);
    expect(duressStatus().armed).toBe(true);
  });

  it("says plainly when what was picked is too large for a code", async () => {
    await seed();
    const refuse = vi.fn(async () => ({
      ok: false as const,
      code: "too_large" as const,
    }));
    render(<DuressPanel arm={refuse} />);
    await openMode();
    await userEvent.click(hideSwitch("Netflix"));
    await typeCode("739104628");
    await userEvent.click(tick());
    await userEvent.click(go());
    expect(
      (
        await screen.findAllByText(
          "Those items are too large to keep with a code. Show fewer.",
        )
      ).length,
    ).toBeGreaterThan(0);
  });
});
