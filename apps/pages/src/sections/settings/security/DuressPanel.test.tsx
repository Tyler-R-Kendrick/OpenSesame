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
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { onCompleteUnlockCodeSubmission } from "@opensesame/app-core/sections/settings/security/duress-unlock-bridge.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
      expect(
        await screen.findByText(
          "It could not be cleared. Try again.",
          {},
          SEALING,
        ),
      ).toBeTruthy();
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
