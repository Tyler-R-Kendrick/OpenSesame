import { mintVaultKey } from "@opensesame/vault-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readLocalPasskeys } from "./local-credentials.js";
import { changeLocalDirectory } from "./local-directory.js";
import {
  authenticateLocalPasskey,
  enrollLocalPasskey,
} from "./local-passkeys.js";
import { vaultStore } from "./vault/store.js";
import { lockAllTombs, unlockTomb } from "./vfs.js";

import { authenticator, origin, rpID } from "./local-authenticator.fixture.js";

let tomb: string;
let principalId: string;
let device: Awaited<ReturnType<typeof authenticator>>;
beforeEach(async () => {
  tomb = `iam-${crypto.randomUUID()}`;
  unlockTomb(tomb, (await mintVaultKey()).vaultKey);
  device = await authenticator();
  let queue = Promise.resolve();
  vi.stubGlobal("isSecureContext", true);
  vi.stubGlobal("location", { origin, hostname: rpID });
  vi.stubGlobal("navigator", {
    credentials: device,
    locks: {
      request: <T>(_name: string, run: () => Promise<T>) => {
        const next = queue.then(run);
        queue = next.then(
          () => undefined,
          () => undefined,
        );
        return next;
      },
    },
  });
  const directory = await changeLocalDirectory(tomb, 0, {
    action: "create",
    kind: "person",
    name: "Local person",
  });
  const person = directory.entries[0];
  if (!person) throw new Error("No person");
  principalId = person.id;
});
afterEach(() => {
  lockAllTombs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("sign-in WebAuthn PRF", () => {
  it("records PRF capability when sign-in evaluates a usable result", async () => {
    await enrollLocalPasskey(tomb, principalId);
    const original = device.get.bind(device);
    vi.spyOn(device, "get").mockImplementation(async (options) => {
      const credential = await original(options);
      if (credential && "getClientExtensionResults" in credential) {
        const output = crypto.getRandomValues(new Uint8Array(32));
        credential.getClientExtensionResults = () => ({
          prf: { results: { first: output.buffer } },
        });
      }
      return credential;
    });
    await authenticateLocalPasskey(tomb, principalId);
    expect((await readLocalPasskeys(tomb))[0]?.prfCapable).toBe(true);
  });

  it("wraps the open vault with the sign-in PRF output", async () => {
    const { vaultStore } = await import("./vault/store.js");
    await vaultStore.create("correct horse battery staple");
    const directory = await changeLocalDirectory(vaultStore.activeTomb(), 0, {
      action: "create",
      kind: "person",
      name: "Vault person",
    });
    const person = directory.entries[0];
    if (!person) throw new Error("No person");
    await enrollLocalPasskey(vaultStore.activeTomb(), person.id);
    const original = device.get.bind(device);
    vi.spyOn(device, "get").mockImplementation(async (options) => {
      const assertion = await original(options);
      if (assertion && "getClientExtensionResults" in assertion) {
        const output = crypto.getRandomValues(new Uint8Array(32));
        assertion.getClientExtensionResults = () => ({
          prf: { results: { first: output.buffer } },
        });
      }
      return assertion;
    });
    try {
      await authenticateLocalPasskey(vaultStore.activeTomb(), person.id);
      expect(
        vaultStore.protection
          .listProtectors()
          .some((record) => record.kind === "webauthn-prf"),
      ).toBe(true);
    } finally {
      vaultStore.lock();
    }
  });
});
