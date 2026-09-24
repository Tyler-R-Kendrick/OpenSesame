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
  enrollPassword: vi.fn(),
  changeMasterPassword: vi.fn(),
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
 * The master password is set and changed in this card and nowhere else
 * (AGENTS.md: never a second PIN or password form), so the checks the old
 * Security › Master password panel made live here now.
 */
describe("SecretKeyCard — the master password", () => {
  beforeEach(() => {
    for (const fn of Object.values(store)) fn.mockReset();
    run.mockClear();
  });

  afterEach(() => {
    cleanup();
  });

  it("asks for the current password before a change, and re-wraps with it", async () => {
    const onDone = vi.fn();
    render(
      <SecretKeyCard
        kind="password"
        view="change"
        busy={false}
        run={run}
        onDone={onDone}
      />,
    );
    await userEvent.type(
      screen.getByLabelText("New password"),
      "correct horse battery",
    );
    await userEvent.type(
      screen.getByLabelText("Confirm new password"),
      "correct horse battery",
    );
    // Without the current password the change cannot be made.
    expect(button("Change password").disabled).toBe(true);
    await userEvent.type(
      screen.getByLabelText("Current password"),
      "old-password-1",
    );
    await userEvent.click(button("Change password"));
    await waitFor(() =>
      expect(store.changeMasterPassword).toHaveBeenCalledWith(
        "old-password-1",
        "correct horse battery",
      ),
    );
    expect(store.enrollPassword).not.toHaveBeenCalled();
    expect(onDone).toHaveBeenCalled();
  });

  it("sets a first password without asking for one that does not exist", () => {
    render(
      <SecretKeyCard
        kind="password"
        view="add"
        busy={false}
        run={run}
        onDone={() => {}}
      />,
    );
    expect(screen.queryByLabelText("Current password")).toBeNull();
  });

  it("suggests a strong password, fills the confirm and reveals it", async () => {
    render(
      <SecretKeyCard
        kind="password"
        view="change"
        busy={false}
        run={run}
        onDone={() => {}}
      />,
    );
    const field = screen.getByLabelText<HTMLInputElement>("New password");
    expect(field.type).toBe("password");
    await userEvent.click(button("Suggest a strong password"));
    const revealed = screen.getByLabelText<HTMLInputElement>("New password");
    expect(revealed.type).toBe("text");
    expect(revealed.value.length).toBeGreaterThan(11);
    expect(
      screen.getByLabelText<HTMLInputElement>("Confirm new password").value,
    ).toBe(revealed.value);
  });

  it("changes a PIN without a current-PIN field", () => {
    render(
      <SecretKeyCard
        kind="pin"
        view="change"
        busy={false}
        run={run}
        onDone={() => {}}
      />,
    );
    expect(screen.queryByLabelText("Current password")).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Suggest a strong password" }),
    ).toBeNull();
  });
});

afterAll(() => {
  Object.assign(vaultHooksSeams, originalVaultHooksSeams);
});
