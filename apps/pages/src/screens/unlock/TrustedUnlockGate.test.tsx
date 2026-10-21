/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { unlockCeremonyStore } from "../../lib/unlock-ceremony-store.js";
import { vaultHooksSeams } from "../../lib/vault/hooks.js";
import { TrustedUnlockGate } from "./TrustedUnlockGate.js";

const original = vaultHooksSeams.useVaultStore;
const confirm = vi.fn(async () => undefined);
const store = {
  confirmTrustedContact: confirm,
  getSnapshot: () => ({ status: "unlocked" }),
};

beforeEach(() => {
  confirm.mockClear();
  vaultHooksSeams.useVaultStore = () => store as never;
  unlockCeremonyStore.begin();
});

afterEach(() => {
  cleanup();
  unlockCeremonyStore.reset();
  vaultHooksSeams.useVaultStore = original;
});

const challenge = {
  name: "Family",
  threshold: 2,
  members: [
    { id: "local_a", name: "Ada" },
    { id: "local_b", name: "Ben" },
  ],
  approved: [],
};

describe("the trusted-contact gate", () => {
  it("ends the unlock ceremony when the last approval opens the vault", async () => {
    render(
      <TrustedUnlockGate challenge={challenge} onCancel={() => undefined} />,
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Approve as Ada" }),
    );
    await waitFor(() => expect(confirm).toHaveBeenCalledWith("local_a"));
    await waitFor(() => expect(unlockCeremonyStore.getSnapshot()).toBe(false));
  });

  it("ends the unlock ceremony when the person cancels", async () => {
    render(
      <TrustedUnlockGate challenge={challenge} onCancel={() => undefined} />,
    );
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(unlockCeremonyStore.getSnapshot()).toBe(false);
  });
});
