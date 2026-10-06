/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const store = vi.hoisted(() => ({
  enrollPin: vi.fn(),
}));

import { vaultHooksSeams } from "../../../lib/vault/hooks.js";
const originalVaultHooksSeams = { ...vaultHooksSeams };
Object.assign(vaultHooksSeams, { useVaultStore: () => store });

import { SecretKeyCard } from "./SecretKeyCard.js";

const run = vi.fn(async (action: () => Promise<void>) => {
  await action();
});

function button(name: string) {
  return screen.getByRole<HTMLButtonElement>("button", { name });
}

/**
 * A PIN is set and changed in this card and nowhere else (AGENTS.md: never a
 * second PIN form). There is no password card (ADR 0180).
 */
describe("SecretKeyCard — the PIN", () => {
  beforeEach(() => {
    for (const fn of Object.values(store)) fn.mockReset();
    run.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("sets a PIN once both entries match", async () => {
    const onDone = vi.fn();
    render(<SecretKeyCard view="add" busy={false} run={run} onDone={onDone} />);
    expect(button("Set PIN").disabled).toBe(true);
    await userEvent.type(screen.getByLabelText("PIN"), "48271639");
    await userEvent.type(screen.getByLabelText("Confirm PIN"), "48271639");
    await userEvent.click(button("Set PIN"));
    await waitFor(() =>
      expect(store.enrollPin).toHaveBeenCalledWith("48271639"),
    );
    expect(onDone).toHaveBeenCalled();
  });

  it("holds a PIN that does not match back", async () => {
    render(
      <SecretKeyCard view="add" busy={false} run={run} onDone={() => {}} />,
    );
    await userEvent.type(screen.getByLabelText("PIN"), "48271639");
    await userEvent.type(screen.getByLabelText("Confirm PIN"), "48271630");
    expect(button("Set PIN").disabled).toBe(true);
    expect(store.enrollPin).not.toHaveBeenCalled();
  });

  it("changes a PIN without asking for a current one, and offers no password", () => {
    render(
      <SecretKeyCard view="change" busy={false} run={run} onDone={() => {}} />,
    );
    expect(screen.getByText("Enrolled")).toBeTruthy();
    expect(screen.queryByLabelText("Current password")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Suggest a strong password" }),
    ).toBeNull();
  });
});

afterAll(() => {
  Object.assign(vaultHooksSeams, originalVaultHooksSeams);
});
