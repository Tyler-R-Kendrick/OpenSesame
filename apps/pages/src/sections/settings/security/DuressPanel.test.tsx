/** @vitest-environment jsdom */
import {
  clearDuressIncidents,
  duressStatus,
  enableDuressCode,
  removeDuressCode,
} from "@opensesame/app-core/lib/duress/settings/device-duress.js";
import { journalSeams } from "@opensesame/app-core/lib/duress/store/journal.js";
import { clearEnrollmentStateForUnlock } from "@opensesame/app-core/lib/duress/store/unlock-enrollment.js";
import { kvFlush } from "@opensesame/app-core/lib/kv.js";
import { listNotices } from "@opensesame/app-core/lib/notices.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { onCompleteUnlockCodeSubmission } from "@opensesame/app-core/sections/settings/security/duress-unlock-bridge.js";
import {
  act,
  cleanup,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DuressPanel } from "./DuressPanel.js";

const CODE = "739104628";
const SEALING = { timeout: 30000 };

// Every test here derives a key or two; a loaded runner needs the room.
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

/** This jsdom keeps no files, and a real browser refuses to arm then. */
const arm: typeof enableDuressCode = (input) =>
  enableDuressCode({ ...input, requireDurable: false });

function fields(): HTMLInputElement[] {
  return [
    ...document.querySelectorAll("[role=dialog] input[type=password]"),
  ].filter(
    (node): node is HTMLInputElement => node instanceof HTMLInputElement,
  );
}

async function typeCode(code: string, again = code) {
  const [first, second] = fields();
  if (!first || !second) throw new Error("the sheet has no code fields");
  await userEvent.type(first, code);
  await userEvent.type(second, again);
}

/** The code typed where a vault unlocks: the device is fenced after it. */
async function useTheCode() {
  await arm({ code: CODE, outcome: "decoy", vaultRef: "personal" });
  const outcome = await onCompleteUnlockCodeSubmission(CODE, {
    requireDurable: false,
  });
  if (outcome.kind === "duress") outcome.match.plaintext.compartmentKey.fill(0);
}

/**
 * Nothing set, nothing fenced, and no write still on its way. Arming writes
 * to the origin's files after the call returns, so a reset that does not wait
 * lets the last test's code land in the next one's device.
 */
async function resetDevice() {
  await kvFlush();
  clearEnrollmentStateForUnlock();
  await clearDuressIncidents();
  await kvFlush();
  clearEnrollmentStateForUnlock();
}

describe("DuressPanel", () => {
  beforeEach(async () => {
    await resetDevice();
    await vaultStore.createWithPin("48291037");
  });
  afterEach(async () => {
    cleanup();
    // Let the session's own writes land before the tomb is torn down.
    await resetDevice();
    vaultStore.lock();
    await vaultStore.destroy();
  });

  it("draws nothing while the vault is locked", () => {
    vaultStore.lock();
    const { container } = render(<DuressPanel arm={arm} />);
    expect(container.innerHTML).toBe("");
  });

  it("is off until a code is set, and offers Add", () => {
    render(<DuressPanel arm={arm} />);
    expect(screen.getByRole("heading", { name: "Duress" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Add" })).toBeTruthy();
    expect(duressStatus().armed).toBe(false);
  });

  it("sets a code from Settings and then offers Change", async () => {
    render(<DuressPanel arm={arm} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await typeCode(CODE);
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(
      screen.getByRole("button", { name: "Turn on duress code" }),
    );
    // Sealing the code runs a key derivation, slow on a loaded runner.
    await waitFor(() => expect(duressStatus().armed).toBe(true), SEALING);
    expect(
      await screen.findByText("Duress code is on.", {}, SEALING),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Change" })).toBeTruthy();
  });

  it("holds the button until the code is acceptable, typed twice, and understood", async () => {
    render(<DuressPanel arm={arm} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    const go = screen.getByRole("button", { name: "Turn on duress code" });
    expect(go.hasAttribute("disabled")).toBe(true);
    await typeCode("1234");
    await userEvent.click(screen.getByRole("checkbox"));
    expect(go.hasAttribute("disabled")).toBe(true);
  });

  it("says why a code was refused, in the card, and keeps what was typed", async () => {
    render(<DuressPanel arm={arm} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await typeCode(CODE);
    await userEvent.click(screen.getByRole("checkbox"));
    // A device already fenced refuses a new code.
    await useTheCode();
    await userEvent.click(
      screen.getByRole("button", { name: "Turn on duress code" }),
    );
    expect(
      await screen.findByText(
        "A duress response holds this device.",
        {},
        SEALING,
      ),
    ).toBeTruthy();
    // The sheet stays open with what was typed, so it can be fixed.
    expect(fields()[0]?.value).toBe(CODE);
  });

  it("lets the owner clear what the code set off, and the code stays on", async () => {
    await useTheCode();
    render(<DuressPanel arm={arm} />);
    expect(screen.queryByRole("button", { name: "Change" })).toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(
      await screen.findByText("Cleared. The code is still on.", {}, SEALING),
    ).toBeTruthy();
    expect(duressStatus()).toEqual({ armed: true, incidents: 0 });
    expect(await removeDuressCode()).toEqual({ ok: true });
  });

  it("does not say it cleared when storage will not let go, and can be tried again", async () => {
    await useTheCode();
    render(<DuressPanel arm={arm} />);
    const kept = journalSeams.deleteDurable;
    journalSeams.deleteDurable = async () => {
      throw new Error("storage refused the delete");
    };
    try {
      await userEvent.click(screen.getByRole("button", { name: "Clear" }));
      await waitFor(
        () =>
          expect(
            listNotices().find((notice) => notice.id === "duress-code")?.body,
          ).toBe("It could not be cleared. Try again."),
        SEALING,
      );
      // A failure is a tray notice, not a box in the page.
      expect(document.querySelector(".note")).toBeNull();
      expect(duressStatus().incidents).toBe(1);
      expect(screen.getByRole("button", { name: "Clear" })).toBeTruthy();
    } finally {
      journalSeams.deleteDurable = kept;
    }
    await userEvent.click(screen.getByRole("button", { name: "Clear" }));
    expect(
      await screen.findByText("Cleared. The code is still on.", {}, SEALING),
    ).toBeTruthy();
    expect(duressStatus().incidents).toBe(0);
  });
});

/** An arming the test holds open, to look at the sheet while it is in flight. */
function heldArm(result: Awaited<ReturnType<typeof enableDuressCode>>) {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const slow: typeof enableDuressCode = async () => {
    await held;
    return result;
  };
  return { slow, release };
}

function dialog(): HTMLElement | null {
  return screen.queryByRole("dialog", { name: "Duress code" });
}

async function openAndFill() {
  await userEvent.click(screen.getByRole("button", { name: "Add" }));
  await typeCode(CODE);
  await userEvent.click(screen.getByRole("checkbox"));
}

describe("DuressPanel sheet while arming", () => {
  beforeEach(async () => {
    await resetDevice();
    await vaultStore.createWithPin("48291037");
  });
  afterEach(async () => {
    cleanup();
    await resetDevice();
    vaultStore.lock();
    await vaultStore.destroy();
  });

  it("does not close on Escape, the scrim or the close key until the write settles", async () => {
    const { slow, release } = heldArm({ ok: true });
    render(<DuressPanel arm={slow} />);
    await openAndFill();
    await userEvent.click(
      screen.getByRole("button", { name: "Turn on duress code" }),
    );
    await waitFor(() =>
      expect(dialog()?.getAttribute("aria-busy")).toBe("true"),
    );
    await userEvent.keyboard("{Escape}");
    for (const close of screen.getAllByRole("button", { name: "Close" })) {
      expect(close.getAttribute("aria-disabled")).toBe("true");
      await userEvent.click(close);
    }
    expect(dialog()).not.toBeNull();
    await act(async () => {
      release();
    });
    await waitFor(() => expect(dialog()).toBeNull());
    expect(await screen.findByText("Duress code is on.")).toBeTruthy();
  });

  it("stays open when the write fails, and then closes like any sheet", async () => {
    const { slow, release } = heldArm({ ok: false, code: "failed" });
    render(<DuressPanel arm={slow} />);
    await openAndFill();
    await userEvent.click(
      screen.getByRole("button", { name: "Turn on duress code" }),
    );
    await userEvent.keyboard("{Escape}");
    expect(dialog()).not.toBeNull();
    await act(async () => {
      release();
    });
    await waitFor(() => expect(dialog()?.getAttribute("aria-busy")).toBeNull());
    expect(screen.getByText("The code could not be set.")).toBeTruthy();
    expect(dialog()).not.toBeNull();
    expect(
      screen
        .getAllByRole("button", { name: "Close" })[0]
        ?.getAttribute("aria-disabled"),
    ).toBeNull();
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(dialog()).toBeNull());
  });

  it("closes with the vault, so the next unlock opens no sheet", async () => {
    render(<DuressPanel arm={arm} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(dialog()).not.toBeNull();
    act(() => vaultStore.lock());
    await waitFor(() => expect(dialog()).toBeNull());
    await act(async () => {
      await vaultStore.unlockWithPin("48291037");
    });
    expect(await screen.findByRole("button", { name: "Add" })).toBeTruthy();
    expect(dialog()).toBeNull();
    // Unlocking touches the tomb's files; let those writes land, with the
    // device still unlocked, before the next test destroys the tomb.
    await kvFlush();
    await new Promise((resolve) => setTimeout(resolve, 250));
    await kvFlush();
  });
});

describe("DuressPanel acknowledgement", () => {
  beforeEach(async () => {
    await resetDevice();
    await vaultStore.createWithPin("48291037");
  });
  afterEach(async () => {
    cleanup();
    await resetDevice();
    vaultStore.lock();
    await vaultStore.destroy();
  });

  it("is not carried to another outcome, nor back to the first", async () => {
    render(<DuressPanel arm={arm} />);
    await openAndFill();
    const go = screen.getByRole("button", { name: "Turn on duress code" });
    expect(go.hasAttribute("disabled")).toBe(false);
    await userEvent.click(
      screen.getByRole("radio", { name: "Wrong password" }),
    );
    const box = screen.getByRole("checkbox");
    expect(box instanceof HTMLInputElement && box.checked).toBe(false);
    expect(go.hasAttribute("disabled")).toBe(true);
    await userEvent.click(screen.getByRole("radio", { name: "Decoy vault" }));
    expect(box instanceof HTMLInputElement && box.checked).toBe(false);
    expect(go.hasAttribute("disabled")).toBe(true);
  });

  it("is not carried to the next opening of the sheet", async () => {
    render(<DuressPanel arm={arm} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.keyboard("{Escape}");
    await waitFor(() => expect(dialog()).toBeNull());
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    const box = screen.getByRole("checkbox");
    expect(box instanceof HTMLInputElement && box.checked).toBe(false);
  });
});

describe("DuressPanel outcome choice", () => {
  beforeEach(async () => {
    await resetDevice();
    await vaultStore.createWithPin("48291037");
  });
  afterEach(async () => {
    cleanup();
    await resetDevice();
    vaultStore.lock();
    await vaultStore.destroy();
  });

  it("is a native radio group, with no radiogroup role over plain buttons", async () => {
    render(<DuressPanel arm={arm} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    const group = screen.getByRole("group", { name: "Entering it shows" });
    const radios = within(group).getAllByRole("radio");
    expect(radios.map((radio) => radio.getAttribute("type"))).toEqual([
      "radio",
      "radio",
    ]);
    // ARIA: a radiogroup owns radios. Any other child makes the role invalid.
    for (const owner of document.querySelectorAll("[role=radiogroup]")) {
      expect(
        owner.querySelectorAll("[role=radio], input[type=radio]").length,
      ).toBeGreaterThan(0);
      expect(owner.querySelector("button[aria-pressed]")).toBeNull();
    }
    expect(document.querySelector("[role=dialog] [aria-pressed]")).toBeNull();
  });

  it("is one native group, so the browser owns the arrows and Tab leaves in one press", async () => {
    render(<DuressPanel arm={arm} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    const [decoy, refuse] = screen.getAllByRole("radio");
    if (!(decoy instanceof HTMLInputElement)) throw new Error("no radio");
    if (!(refuse instanceof HTMLInputElement)) throw new Error("no radio");
    // One name is what makes the arrows move the choice and Tab skip the rest.
    expect(decoy.name).not.toBe("");
    expect(refuse.name).toBe(decoy.name);
    expect(decoy.tabIndex).toBe(0);
    expect(refuse.tabIndex).toBe(0);
    decoy.focus();
    await userEvent.tab();
    expect(document.activeElement).toBe(fields()[0]);
  });
});

describe("DuressPanel in a guest session", () => {
  beforeEach(async () => {
    await resetDevice();
  });
  afterEach(async () => {
    cleanup();
    await kvFlush();
    vaultStore.lock();
    await vaultStore.destroy();
  });

  it("draws nothing to a guest, which is what a decoy is", async () => {
    await vaultStore.createGuest();
    const { container } = render(<DuressPanel arm={arm} />);
    expect(container.innerHTML).toBe("");
  });
});
