/** @vitest-environment jsdom */
import type { enableDuressCode } from "@opensesame/app-core/lib/duress/settings/device-duress.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { inTray } from "../../../components/tray.test-support.js";
import { DuressPanel } from "./DuressPanel.js";

const REFUSAL =
  "That code opens a vault on this device. Pick one you never use to unlock.";

const collides: typeof enableDuressCode = async () => ({
  ok: false,
  code: "collides",
});

vi.setConfig({ testTimeout: 60000, hookTimeout: 60000 });

beforeEach(async () => {
  await vaultStore.createWithPin("48291037");
});

afterEach(async () => {
  cleanup();
  vaultStore.lock();
  await vaultStore.destroy();
});

describe("DuressPanel, a code that opens a vault", () => {
  it("keeps the instruction in the page, on the field, and does not tray it", async () => {
    render(<DuressPanel arm={collides} />);
    await userEvent.click(screen.getByRole("button", { name: "Add" }));
    const [first, again] = document.querySelectorAll<HTMLInputElement>(
      "[role=dialog] input[type=password]",
    );
    if (!first || !again) throw new Error("no code fields");
    await userEvent.type(first, "739104628");
    await userEvent.type(again, "739104628");
    await userEvent.click(screen.getByRole("checkbox"));
    await userEvent.click(
      screen.getByRole("button", { name: "Turn on duress code" }),
    );
    expect(await screen.findByText(REFUSAL)).toBeTruthy();
    expect(screen.getByRole("img", { name: REFUSAL })).toBeTruthy();
    expect(inTray(REFUSAL)).toBe(false);
  });
});
