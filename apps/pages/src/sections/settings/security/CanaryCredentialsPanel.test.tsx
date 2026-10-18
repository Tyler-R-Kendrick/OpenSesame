/** @vitest-environment jsdom */
import type {
  LocalCanaryCommand,
  LocalCanaryResult,
  LocalVaultOperation,
  LocalVaultPrimary,
} from "@opensesame/vault-core/local-vault-security.js";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { CanaryCredentialsSheet } from "./CanaryCredentialsPanel.js";
afterEach(cleanup);
const inspection: LocalCanaryResult = {
  kind: "inspection",
  records: [],
  events: [],
  inactiveIds: [],
};
async function configure(kind: "pairing" | "inspect" = "inspect") {
  const user = userEvent.setup();
  await user.type(
    screen.getByLabelText("Receiver endpoint"),
    "http://127.0.0.1:34567",
  );
  await user.type(screen.getByLabelText("Receiver service ID"), "a".repeat(64));
  await user.clear(screen.getByLabelText("Allowed browser origin"));
  await user.type(
    screen.getByLabelText("Allowed browser origin"),
    "https://vault.example",
  );
  await user.type(screen.getByLabelText("Receiver bind port"), "34567");
  if (kind === "pairing")
    await user.selectOptions(screen.getByLabelText("Operation"), "pairing");
  await user.click(
    screen.getByRole("button", {
      name: kind === "pairing" ? "Pair receiver" : "Review canaries",
    }),
  );
  return user;
}
async function authenticate() {
  const user = userEvent.setup();
  await user.type(
    screen.getByLabelText("Current password"),
    "current fixture password",
  );
  await user.click(screen.getByRole("button", { name: "Verify current key" }));
  return user;
}
it("binds explicit receiver and fresh current key to each consented enrollment", async () => {
  const beginCanary = vi.fn(
    async (_primary: LocalVaultPrimary, _command: LocalCanaryCommand) => ({
      kind: "complete" as const,
      result: inspection,
    }),
  );
  render(
    <CanaryCredentialsSheet
      port={{ beginCanary, isCanaryResultCurrent: () => true }}
      methods={["password"]}
      onClose={() => {}}
    />,
  );
  await configure();
  expect(beginCanary).not.toHaveBeenCalled();
  await authenticate();
  await screen.findByText("No active canaries.");
  const user = userEvent.setup();
  await user.type(screen.getByLabelText("Canary name"), "Controlled detector");
  const enroll = screen.getByRole("button", { name: "Add canary" });
  expect(enroll.hasAttribute("disabled")).toBe(true);
  await user.click(
    screen.getByLabelText(/I control where this detection-only/),
  );
  await user.click(enroll);
  expect(beginCanary).toHaveBeenCalledTimes(1);
  await authenticate();
  expect(beginCanary.mock.calls[1]?.[1]).toEqual({
    receiver: {
      endpoint: "http://127.0.0.1:34567",
      serviceId: "a".repeat(64),
      browserOrigin: "https://vault.example",
      bindPort: 34567,
    },
    action: {
      kind: "enroll",
      label: "Controlled detector",
      artifactKind: "mcp-config",
      retentionDays: 90,
      ownerConsent: true,
    },
  });
});
it("does not expose canary receipts before configured second step and cancels on close", async () => {
  const cancel = vi.fn(async () => {});
  const operation: LocalVaultOperation<LocalCanaryResult> = {
    kind: "challenge",
    routes: ["totp"],
    requestCode: vi.fn(),
    complete: vi.fn(async () => inspection),
    cancel,
  };
  const view = render(
    <CanaryCredentialsSheet
      port={{
        beginCanary: async () => operation,
        isCanaryResultCurrent: () => true,
      }}
      methods={["password"]}
      onClose={() => {}}
    />,
  );
  await configure();
  await authenticate();
  await screen.findByLabelText("Verification code");
  expect(screen.queryByText("No active canaries.")).toBeNull();
  view.unmount();
  expect(cancel).toHaveBeenCalledTimes(1);
});
it("pairs only with fresh owner authentication and refuses stale result presentation", async () => {
  const pairing: LocalCanaryResult = {
    kind: "pairing",
    pairing: {
      v: 1,
      endpoint: "http://127.0.0.1:34567",
      serviceId: "a".repeat(64),
      bindPort: 34567,
      origin: "https://vault.example",
      ownerKeyId: "b".repeat(64),
      ownerPublicJwk: {
        kty: "EC",
        crv: "P-256",
        x: "x".repeat(43),
        y: "y".repeat(43),
      },
    },
  };
  const beginCanary = vi.fn(async () => ({
    kind: "complete" as const,
    result: pairing,
  }));
  render(
    <CanaryCredentialsSheet
      port={{ beginCanary, isCanaryResultCurrent: () => false }}
      methods={["password"]}
      onClose={() => {}}
    />,
  );
  await configure("pairing");
  expect(beginCanary).not.toHaveBeenCalled();
  await authenticate();
  expect(screen.queryByLabelText("Receiver pairing document")).toBeNull();
  expect(
    screen.queryByRole("button", { name: "Download pairing document" }),
  ).toBeNull();
});
