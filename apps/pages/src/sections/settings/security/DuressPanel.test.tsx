/** @vitest-environment jsdom */
import {
  duressStatus,
  removeDuressCode,
} from "@opensesame/app-core/lib/duress/settings/device-duress.js";
import { journalSeams } from "@opensesame/app-core/lib/duress/store/journal.js";
import { kvFlush } from "@opensesame/app-core/lib/kv.js";
import { listNotices } from "@opensesame/app-core/lib/notices.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { expectInTray, inTray } from "../../../components/tray.test-support.js";
import { DuressPanel } from "./DuressPanel.js";
import {
  CODE,
  SEALING,
  arm,
  fields,
  resetDevice,
  typeCode,
  useTheCode,
} from "./DuressPanel.test-support.js";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

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

  it("trays why a code was refused, marks the field, and keeps what was typed", async () => {
    render(<DuressPanel arm={arm} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    await typeCode(CODE);
    await userEvent.click(screen.getByRole("checkbox"));
    // A device already fenced refuses a new code.
    await useTheCode();
    await userEvent.click(
      screen.getByRole("button", { name: "Turn on duress code" }),
    );
    // Sealing derives a key; give it the room before the tray check.
    await waitFor(
      () => expect(inTray("A duress response holds this device.")).toBe(true),
      SEALING,
    );
    await expectInTray("A duress response holds this device.");
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
