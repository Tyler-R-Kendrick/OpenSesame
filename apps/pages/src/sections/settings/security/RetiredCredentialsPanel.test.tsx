/** @vitest-environment jsdom */
import type {
  LocalRetiredCommand,
  LocalRetiredInspection,
  LocalVaultOperation,
  LocalVaultPrimary,
} from "@opensesame/vault-core/local-vault-security.js";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { RetiredCredentialsSheet } from "./RetiredCredentialsPanel.js";
afterEach(cleanup);
const inspection: LocalRetiredInspection = {
  traps: [],
  events: [],
  stale: false,
};
async function authenticate() {
  const user = userEvent.setup();
  await user.type(
    screen.getByLabelText("Current password"),
    "current private password",
  );
  await user.click(screen.getByRole("button", { name: "Verify current key" }));
  return user;
}
it("requires fresh primary for inspection and enrollment, with synthetic consent", async () => {
  const beginRetired = vi.fn(
    async (_primary: LocalVaultPrimary, _command: LocalRetiredCommand) => ({
      kind: "complete" as const,
      result: inspection,
    }),
  );
  render(
    <RetiredCredentialsSheet
      port={{ beginRetired, isRetiredResultCurrent: () => true }}
      methods={["password"]}
      onClose={() => {}}
    />,
  );
  expect(screen.queryByText("No retired passwords are enrolled.")).toBeNull();
  const user = await authenticate();
  await screen.findByText("No retired passwords are enrolled.");
  await user.type(
    screen.getByLabelText("Retired password"),
    "controlled old password",
  );
  await user.click(
    screen.getByLabelText("Open a synthetic vault when this password is used"),
  );
  const add = screen.getByRole("button", { name: "Add retired password" });
  expect(add.hasAttribute("disabled")).toBe(true);
  await user.click(
    screen.getByLabelText(/I understand this creates fictional/),
  );
  await user.click(add);
  expect(beginRetired).toHaveBeenCalledTimes(1);
  expect(screen.queryByLabelText("Retired password")).toBeNull();
  await authenticate();
  expect(beginRetired.mock.calls[1]?.[1]).toEqual({
    kind: "change",
    change: {
      type: "enroll",
      password: "controlled old password",
      response: "synthetic_decoy",
      retentionMs: 7776000000,
    },
  });
});
it("keeps inspection hidden until configured second step completes", async () => {
  const operation: LocalVaultOperation<LocalRetiredInspection> = {
    kind: "challenge",
    routes: ["totp"],
    requestCode: vi.fn(),
    complete: vi.fn(async () => inspection),
    cancel: vi.fn(async () => {}),
  };
  const view = render(
    <RetiredCredentialsSheet
      port={{
        beginRetired: async () => operation,
        isRetiredResultCurrent: () => true,
      }}
      methods={["password"]}
      onClose={() => {}}
    />,
  );
  const user = await authenticate();
  await screen.findByLabelText("Verification code");
  expect(screen.queryByText("No retired passwords are enrolled.")).toBeNull();
  await user.type(screen.getByLabelText("Verification code"), "123456");
  await user.click(screen.getByRole("button", { name: "Verify second step" }));
  await screen.findByText("No retired passwords are enrolled.");
  expect(operation.complete).toHaveBeenCalledWith({
    kind: "totp",
    code: "123456",
  });
  view.unmount();
  expect(operation.cancel).not.toHaveBeenCalled();
});
it("cancels a pending challenge on unmount", async () => {
  const cancel = vi.fn(async () => {});
  const operation: LocalVaultOperation<LocalRetiredInspection> = {
    kind: "challenge",
    routes: ["totp"],
    requestCode: vi.fn(),
    complete: vi.fn(),
    cancel,
  };
  const view = render(
    <RetiredCredentialsSheet
      port={{
        beginRetired: async () => operation,
        isRetiredResultCurrent: () => true,
      }}
      methods={["password"]}
      onClose={() => {}}
    />,
  );
  await authenticate();
  await screen.findByLabelText("Verification code");
  view.unmount();
  expect(cancel).toHaveBeenCalledTimes(1);
});
