import { VAULT_RESET_RUNS_KEY } from "@opensesame/app-core/lib/password-reset/vault-run-tracker.js";
import { beforeEach, describe, expect, it, vi } from "vitest";

const activation = {
  disposed: () => false,
  handle: () => ({}),
  register: vi.fn(),
  onDispose: vi.fn(),
};
vi.mock("../activation.js", () => ({
  createActivation: () => activation,
}));
vi.mock("./panel.js", () => ({ PasswordResetMailPanel: () => null }));
vi.mock("./scan.js", () => ({
  createPasswordResetScan: () => ({ start: vi.fn() }),
}));
vi.mock("./rotation-relay.js", () => ({
  createHostResetRunNoticeBridge: () => ({ start: vi.fn() }),
  installPasswordResetRotationRelay: () => vi.fn(),
}));
vi.mock("./vault-ui.js", () => ({
  installPasswordResetVaultUiSeams: () => vi.fn(),
}));

import { capabilityRuntime } from "./runtime.js";

describe("password reset runtime", () => {
  beforeEach(() => {
    activation.register.mockClear();
  });

  it("hydrates tracked jobs before registering the notice bridge", async () => {
    const hydrate = vi.fn(async () => {});
    await capabilityRuntime.activate({ hydrate } as never);
    expect(hydrate).toHaveBeenCalledWith([VAULT_RESET_RUNS_KEY]);
    expect(hydrate.mock.invocationCallOrder[0]).toBeLessThan(
      activation.register.mock.invocationCallOrder[0] ?? 0,
    );
  });

  it("registers the takeover route through the approved capability", async () => {
    await capabilityRuntime.activate({ hydrate: vi.fn() } as never);
    expect(activation.register).toHaveBeenCalledWith(
      "route",
      expect.objectContaining({
        id: "password-reset-takeover",
        path: "/runs/:runId",
        framed: true,
      }),
    );
  });
});
