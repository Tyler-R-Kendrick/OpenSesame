import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock(
  "@opensesame/app-core/sections/settings/security/duress-unlock-bridge.js",
  () => ({
    onCompleteUnlockCodeSubmission: async () => ({ kind: "continue" }),
  }),
);
vi.mock("@opensesame/app-core/lib/projects.js", () => ({
  scopedKey: (key: string) => key,
}));
vi.mock("@opensesame/app-core/lib/vault/store-scope.js", () => ({
  ATTEMPTS_KEY: "attempts",
}));
vi.mock("@opensesame/app-core/lib/vault/unlock-attempts.js", () => ({
  recordFailedUnlock: () => undefined,
}));
vi.mock("@opensesame/app-core/lib/vault/primary-unwrap.js", () => ({
  unwrapPin: async () => new Uint8Array(32),
}));
vi.mock(
  "@opensesame/app-core/lib/cli-app-integration/bearer-session.js",
  () => ({
    readCliAppIntegrationBearer: () => "A".repeat(43),
  }),
);

import { mintCliAuthorizePinProof } from "./cli-authorize-mint-proof.js";

describe("CLI PIN approval", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses a PIN without asking the passkey authenticator", async () => {
    const get = vi.fn();
    vi.stubGlobal("navigator", {
      credentials: { get, create: vi.fn() },
    });
    const row = ["req", "term", "read", "nonce", "daemon", "00", 0, 0] as const;
    await expect(
      mintCliAuthorizePinProof(row, "1234", {} as never),
    ).rejects.toMatchObject({
      code: "pin_not_accepted",
      message:
        "A PIN cannot approve a CLI request. Use the passkey from pairing.",
    });
    expect(get).not.toHaveBeenCalled();
  });
});
