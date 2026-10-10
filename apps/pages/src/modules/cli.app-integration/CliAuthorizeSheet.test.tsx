/** @vitest-environment jsdom */
import { cleanup, render, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliAuthorizeSheet } from "./CliAuthorizeSheet.js";

const respond = vi.fn();

vi.mock("@opensesame/app-core/lib/cli-app-integration/index.js", async () => {
  const actual = await vi.importActual<
    typeof import("@opensesame/app-core/lib/cli-app-integration/index.js")
  >("@opensesame/app-core/lib/cli-app-integration/index.js");
  return {
    ...actual,
    respondCliIntegration: (...args: unknown[]) => respond(...args),
  };
});

vi.mock("@opensesame/app-core/lib/vault/unlock-methods.js", () => ({
  listAvailableUnlockMethods: () => ["pin"],
}));

vi.mock("../../lib/vault/hooks.js", () => ({
  useVaultStore: () => ({
    getSnapshot: () => ({ header: {} }),
    confirmPinStepUp: vi.fn(async () => {}),
    confirmPasskeyStepUp: vi.fn(async () => {}),
  }),
}));

afterEach(() => {
  cleanup();
  respond.mockReset();
});

describe("CliAuthorizeSheet", () => {
  it("shows terminal, command and item facts", () => {
    const { container } = render(
      <CliAuthorizeSheet
        request={{
          requestId: "clr_1",
          terminalSessionId: "term-session-abcdef",
          verb: "read",
          reference: "op://personal/login/password",
          createdAtMs: 0,
        }}
        onClose={() => {}}
        onSettled={() => {}}
      />,
    );
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    expect(dialog?.textContent).toContain("Authorize CLI");
    expect(dialog?.textContent).toContain("Read a secret");
    expect(dialog?.textContent).toContain("personal/login");
    expect(dialog?.textContent).toContain("password");
  });

  it("denies without step-up", async () => {
    const user = userEvent.setup();
    respond.mockResolvedValue(true);
    const onSettled = vi.fn();
    const { container } = render(
      <CliAuthorizeSheet
        request={{
          requestId: "clr_2",
          terminalSessionId: "term-b",
          verb: "run",
          createdAtMs: 0,
        }}
        onClose={() => {}}
        onSettled={onSettled}
      />,
    );
    const dialog = container.querySelector('[role="dialog"]');
    expect(dialog).not.toBeNull();
    await user.click(
      within(dialog as HTMLElement).getByRole("button", { name: "Deny" }),
    );
    expect(respond).toHaveBeenCalledWith("clr_2", "term-b", "deny");
    expect(onSettled).toHaveBeenCalled();
  });
});
