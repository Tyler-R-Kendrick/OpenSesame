/** @vitest-environment jsdom */
import { webLocksDouble } from "@opensesame/app-core/lib/__tests__/web-locks-double.js";
import {
  authenticator,
  origin,
  rpID,
} from "@opensesame/app-core/lib/local-authenticator.fixture.js";
import { readLocalPasskeys } from "@opensesame/app-core/lib/local-credentials.js";
import { changeLocalDirectory } from "@opensesame/app-core/lib/local-directory-admin.js";
import { vaultStore } from "@opensesame/app-core/lib/vault/store.js";
import { lockAllTombs } from "@opensesame/app-core/lib/vfs.js";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { LocalPasskeys } from "./LocalPasskeys.js";

let principalId: string;
let device: Awaited<ReturnType<typeof authenticator>>;
let locks: ReturnType<typeof webLocksDouble>;
beforeEach(async () => {
  // Use WebCrypto's byte realm for the real authenticator and vault operations.
  vi.stubGlobal("Uint8Array", new TextEncoder().encode("").constructor);
  vi.stubGlobal("ArrayBuffer", new TextEncoder().encode("").buffer.constructor);
  device = await authenticator();
  locks = webLocksDouble();
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("location", { origin, hostname: rpID });
  vi.stubGlobal("navigator", {
    credentials: device,
    locks,
  });
  await vaultStore.create("correct horse battery staple");
  const directory = await changeLocalDirectory(vaultStore.activeTomb(), 0, {
    action: "create",
    kind: "person",
    name: "Local person",
  });
  const person = directory.entries[0];
  if (!person) throw new Error("Missing local person");
  principalId = person.id;
});
afterEach(async () => {
  cleanup();
  try {
    const tomb = vaultStore.activeTomb();
    vaultStore.lock();
    // Lock releases its shared lease asynchronously; wait for the real grant
    // before requesting the exclusive destruction operation.
    await locks.request(`opensesame:vault-open:${tomb}`, () => undefined);
    await vaultStore.destroy();
  } finally {
    lockAllTombs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  }
});

function registrationPrf(output: Uint8Array) {
  const create = device.create.bind(device);
  const registration = vi
    .spyOn(device, "create")
    .mockImplementation(async (options) => {
      const credential = await create(options);
      credential.getClientExtensionResults = () => ({
        prf: { results: { first: output.buffer } },
      });
      return credential;
    });
  return () => {
    const salt =
      registration.mock.calls[0]?.[0].publicKey?.extensions?.prf?.eval?.first;
    if (!(salt instanceof Uint8Array))
      throw new Error("Missing registration PRF salt");
    return salt;
  };
}

it("wipes each borrowed PRF copy while preserving the offer for a real enrollment retry", async () => {
  const prfOutput = new Uint8Array(32).fill(7);
  Object.defineProperty(prfOutput.buffer, "slice", {
    value: () => prfOutput.buffer,
  });
  const salt = registrationPrf(prfOutput);
  const copies: ArrayBuffer[] = [];
  let resume: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => {
    resume = resolve;
  });
  const protection = vaultStore.protection;
  const enroll = protection.enrollHeldWebauthnPrf.bind(protection);
  vi.spyOn(protection, "enrollHeldWebauthnPrf")
    .mockImplementationOnce(async (input) => {
      copies.push(input.prfOutput);
      await pending;
      expect(new Uint8Array(input.prfOutput).every((byte) => byte === 7)).toBe(
        true,
      );
      throw new Error("Try again");
    })
    .mockImplementationOnce(async (input) => {
      copies.push(input.prfOutput);
      expect(new Uint8Array(input.prfOutput).every((byte) => byte === 7)).toBe(
        true,
      );
      return enroll(input);
    });
  const commit = protection.commitEnrollment.bind(protection);
  const committed = vi
    .spyOn(protection, "commitEnrollment")
    .mockImplementation(async (id) => {
      expect(
        copies[1] && new Uint8Array(copies[1]).every((byte) => byte === 0),
      ).toBe(true);
      return commit(id);
    });
  try {
    render(
      <LocalPasskeys
        tomb={vaultStore.activeTomb()}
        principalId={principalId}
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
    expect(await readLocalPasskeys(vaultStore.activeTomb())).toHaveLength(1);
    expect(salt().some((byte) => byte !== 0)).toBe(true);
    await userEvent.click(
      screen.getByRole("button", { name: "Also unlock this vault" }),
    );
    await waitFor(() => expect(copies).toHaveLength(1));
    expect(
      copies[0] && new Uint8Array(copies[0]).every((byte) => byte === 7),
    ).toBe(true);
    expect(prfOutput.every((byte) => byte === 7)).toBe(true);
    resume?.();
    expect((await screen.findByRole("alert")).textContent).toBe("Try again");
    expect(
      copies[0] && new Uint8Array(copies[0]).every((byte) => byte === 0),
    ).toBe(true);
    expect(prfOutput.every((byte) => byte === 7)).toBe(true);
    expect(salt().some((byte) => byte !== 0)).toBe(true);
    expect(
      protection
        .listProtectors()
        .some((record) => record.kind === "webauthn-prf"),
    ).toBe(false);
    await userEvent.click(
      screen.getByRole("button", { name: "Also unlock this vault" }),
    );
    await screen.findByRole("img", {
      name: "This passkey can unlock the vault.",
    });
    expect(copies).toHaveLength(2);
    expect(
      copies[1] && new Uint8Array(copies[1]).every((byte) => byte === 0),
    ).toBe(true);
    expect(prfOutput.every((byte) => byte === 0)).toBe(true);
    expect(salt().every((byte) => byte === 0)).toBe(true);
    expect(committed).toHaveBeenCalledOnce();
    expect(
      protection
        .listProtectors()
        .some((record) => record.kind === "webauthn-prf"),
    ).toBe(true);
  } finally {
    resume?.();
  }
});
