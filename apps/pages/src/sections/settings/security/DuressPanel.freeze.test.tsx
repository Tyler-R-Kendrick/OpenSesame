/** @vitest-environment jsdom */
import type { enableDuressCode } from "@opensesame/app-core/lib/duress/settings/device-duress.js";
import { getMode } from "@opensesame/app-core/lib/duress/settings/modes/index.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DuressPanel } from "./DuressPanel.js";
import {
  CODE,
  SEALING,
  arm,
  dialog,
  resetDevice,
  typeCode,
} from "./DuressPanel.test-support.js";

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

const consent = () => {
  const box = screen.getByRole("checkbox");
  if (!(box instanceof HTMLInputElement)) throw new Error("not a checkbox");
  return box;
};
const turnOn = () =>
  screen.getByRole("button", { name: "Turn on duress code" });
const checked = (name: string) => {
  const radio = screen.getByRole("radio", { name });
  return radio instanceof HTMLInputElement && radio.checked;
};

async function openFreeze() {
  await userEvent.click(screen.getByRole("button", { name: "Add" }));
  await typeCode(CODE);
  await userEvent.click(
    screen.getByRole("radio", { name: "Freeze for a while" }),
  );
}

describe("DuressPanel freeze mode", () => {
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

  it("is offered beside the others, with its three durations and none chosen", async () => {
    render(<DuressPanel arm={arm} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    expect(screen.getAllByRole("radio").slice(0, 3)).toHaveLength(3);
    await userEvent.click(
      screen.getByRole("radio", { name: "Freeze for a while" }),
    );
    for (const hours of ["1 hour", "24 hours", "72 hours"]) {
      expect(checked(hours)).toBe(false);
    }
    const mode = getMode("freeze");
    expect(mode && screen.getByText(mode.consent)).toBeTruthy();
  });

  it("stays off until a duration is chosen and the consent is ticked", async () => {
    const seen = vi.fn(arm);
    render(<DuressPanel arm={seen} />);
    await openFreeze();
    expect(turnOn().hasAttribute("disabled")).toBe(true);

    await userEvent.click(consent());
    // Ticked, but no duration: still off.
    expect(turnOn().hasAttribute("disabled")).toBe(true);

    await userEvent.click(screen.getByRole("radio", { name: "24 hours" }));
    expect(turnOn().hasAttribute("disabled")).toBe(false);

    await userEvent.click(turnOn());
    await waitFor(() => expect(dialog()).toBeNull(), SEALING);
    const [request] = seen.mock.calls[0] ?? [];
    expect(request?.mode).toBe("freeze");
    expect(request?.extras).toEqual({ freeze_hours: "24" });
  });

  it("is off with a duration but no consent", async () => {
    render(<DuressPanel arm={arm} />);
    await openFreeze();
    await userEvent.click(screen.getByRole("radio", { name: "72 hours" }));
    expect(consent().checked).toBe(false);
    expect(turnOn().hasAttribute("disabled")).toBe(true);
  });

  it("takes the duration and the consent back when the mode changes", async () => {
    render(<DuressPanel arm={arm} />);
    await openFreeze();
    await userEvent.click(screen.getByRole("radio", { name: "1 hour" }));
    await userEvent.click(consent());
    expect(turnOn().hasAttribute("disabled")).toBe(false);

    await userEvent.click(
      screen.getByRole("radio", { name: "Wrong password" }),
    );
    expect(consent().checked).toBe(false);
    expect(turnOn().hasAttribute("disabled")).toBe(true);

    await userEvent.click(
      screen.getByRole("radio", { name: "Freeze for a while" }),
    );
    expect(checked("1 hour")).toBe(false);
    expect(consent().checked).toBe(false);
    expect(turnOn().hasAttribute("disabled")).toBe(true);
  });

  it("arms through the real path and seals a plan nothing stored names", async () => {
    const real: typeof enableDuressCode = (input) => arm(input);
    render(<DuressPanel arm={real} />);
    await openFreeze();
    await userEvent.click(screen.getByRole("radio", { name: "72 hours" }));
    await userEvent.click(consent());
    await userEvent.click(turnOn());
    expect(
      await screen.findByText("Duress code is on.", {}, SEALING),
    ).toBeTruthy();
  });
});
