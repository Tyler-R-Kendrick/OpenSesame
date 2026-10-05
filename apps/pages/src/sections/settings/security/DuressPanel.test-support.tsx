/** @vitest-environment jsdom */
// Shared by the DuressPanel test files: the device, the code and the sheet.
import {
  clearDuressIncidents,
  enableDuressCode,
} from "@opensesame/app-core/lib/duress/settings/device-duress.js";
import { clearEnrollmentStateForUnlock } from "@opensesame/app-core/lib/duress/store/unlock-enrollment.js";
import { kvFlush } from "@opensesame/app-core/lib/kv.js";
import { onCompleteUnlockCodeSubmission } from "@opensesame/app-core/sections/settings/security/duress-unlock-bridge.js";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { vi } from "vitest";

export const CODE = "739104628";
export const SEALING = { timeout: 30000 };

// Every test here derives a key or two; a loaded runner needs the room.
vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

/** This jsdom keeps no files, and a real browser refuses to arm then. */
export const arm: typeof enableDuressCode = (input) =>
  enableDuressCode({ ...input, requireDurable: false });

export function fields(): HTMLInputElement[] {
  return [
    ...document.querySelectorAll("[role=dialog] input[type=password]"),
  ].filter(
    (node): node is HTMLInputElement => node instanceof HTMLInputElement,
  );
}

export async function typeCode(code: string, again = code) {
  const [first, second] = fields();
  if (!first || !second) throw new Error("the sheet has no code fields");
  await userEvent.type(first, code);
  await userEvent.type(second, again);
}

/** The code typed where a vault unlocks: the device is fenced after it. */
export async function useTheCode() {
  await arm({ code: CODE, mode: "decoy", vaultRef: "personal" });
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
export async function resetDevice() {
  await kvFlush();
  clearEnrollmentStateForUnlock();
  await clearDuressIncidents();
  await kvFlush();
  clearEnrollmentStateForUnlock();
}

/** An arming the test holds open, to look at the sheet while it is in flight. */
export function heldArm(result: Awaited<ReturnType<typeof enableDuressCode>>) {
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

export function dialog(): HTMLElement | null {
  return screen.queryByRole("dialog", { name: "Duress code" });
}

export async function openAndFill() {
  await userEvent.click(screen.getByRole("button", { name: "Add" }));
  await typeCode(CODE);
  await userEvent.click(screen.getByRole("checkbox"));
}
