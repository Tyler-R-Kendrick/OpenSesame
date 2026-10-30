/** @vitest-environment jsdom */
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, expect, it, vi } from "vitest";
import { LocalPasskeys } from "./LocalPasskeys.js";

const seams = vi.hoisted(() => ({
  enrollLocal: vi.fn(),
  enrollHeld: vi.fn(),
  commit: vi.fn(),
}));
vi.mock("@opensesame/app-core/lib/local-credentials.js", () => ({
  readLocalPasskeys: async () => [],
  revokeLocalPasskey: vi.fn(),
}));
vi.mock("@opensesame/app-core/lib/local-iam-events.js", () => ({
  subscribeLocalIamChanges: () => () => {},
}));
vi.mock(
  "@opensesame/app-core/lib/local-passkeys.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@opensesame/app-core/lib/local-passkeys.js")
    >()),
    enrollLocalPasskey: seams.enrollLocal,
  }),
);
vi.mock("../../lib/vault/hooks.js", () => ({
  useVault: () => ({ status: "unlocked" }),
  useVaultStore: () => ({
    protection: {
      enrollHeldWebauthnPrf: seams.enrollHeld,
      commitEnrollment: seams.commit,
    },
  }),
}));
vi.mock("./LocalIdentitySession.js", () => ({
  LocalIdentitySession: () => null,
}));
vi.mock("./LocalPasskeyRows.js", () => ({ CredentialRows: () => null }));
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

it("wipes each borrowed PRF copy while preserving the offer for retry", async () => {
  const prfOutput = new Uint8Array(32).fill(7);
  const prfSalt = new Uint8Array(32).fill(3);
  const discard = vi.fn(() => {
    prfOutput.fill(0);
    prfSalt.fill(0);
  });
  const offer = {
    prfOutput,
    prfSalt,
    credentialId: new Uint8Array([1]).buffer,
    userId: new Uint8Array([2]),
    discard,
  };
  seams.enrollLocal.mockResolvedValue({
    credentialId: "credential",
    prfSupported: true,
    vaultOffer: offer,
  });
  const copies: ArrayBuffer[] = [];
  let resume: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    resume = resolve;
  });
  seams.enrollHeld.mockImplementationOnce(
    async (input: { prfOutput: ArrayBuffer }) => {
      copies.push(input.prfOutput);
      await pending;
      expect(new Uint8Array(input.prfOutput).every((byte) => byte === 7)).toBe(
        true,
      );
      throw new Error("Try again");
    },
  );
  seams.enrollHeld.mockImplementationOnce(
    async (input: { prfOutput: ArrayBuffer }) => {
      copies.push(input.prfOutput);
      expect(new Uint8Array(input.prfOutput).every((byte) => byte === 7)).toBe(
        true,
      );
      return { operationId: "op" };
    },
  );
  seams.commit.mockImplementation(async () => {
    expect(
      copies[1] && new Uint8Array(copies[1]).every((byte) => byte === 0),
    ).toBe(true);
  });
  try {
    render(
      <LocalPasskeys
        tomb="tomb"
        principalId="person"
        disabled={false}
        enabled
      />,
    );
    await userEvent.click(screen.getByText("Passkeys"));
    await userEvent.click(
      await screen.findByRole("button", { name: "Enroll passkey" }),
    );
    await userEvent.click(
      await screen.findByLabelText("Use this passkey to unlock this vault"),
    );
    await userEvent.click(
      screen.getByRole("button", { name: "Also unlock this vault" }),
    );
    await waitFor(() => expect(copies).toHaveLength(1));
    expect(
      copies[0] && new Uint8Array(copies[0]).every((byte) => byte === 7),
    ).toBe(true);
    expect(discard).not.toHaveBeenCalled();
    resume?.();
    await screen.findByRole("alert");
    expect(
      copies[0] && new Uint8Array(copies[0]).every((byte) => byte === 0),
    ).toBe(true);
    expect(prfOutput.every((byte) => byte === 7)).toBe(true);
    expect(discard).not.toHaveBeenCalled();
    await userEvent.click(
      screen.getByRole("button", { name: "Also unlock this vault" }),
    );
    await waitFor(() => expect(discard).toHaveBeenCalledOnce());
    expect(copies).toHaveLength(2);
    expect(
      copies[1] && new Uint8Array(copies[1]).every((byte) => byte === 0),
    ).toBe(true);
    expect(prfOutput.every((byte) => byte === 0)).toBe(true);
    expect(prfSalt.every((byte) => byte === 0)).toBe(true);
    expect(seams.commit).toHaveBeenCalledOnce();
  } finally {
    resume?.();
  }
});
