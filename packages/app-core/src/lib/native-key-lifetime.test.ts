import { randomBytes } from "node:crypto";
import { overlapCast } from "@opensesame/os-domain";
import { expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { installNativeApiTests } from "./native-api.test-support.js";
import {
  encryptBytes,
  masterKey,
  stretchMasterKey,
  symmetricKey,
} from "./native-bitwarden-crypto.js";
import { bitwardenVaultKeyFlows } from "./native-bitwarden-vault.js";

installNativeApiTests();

const ITEM = "11111111-1111-4111-8111-111111111111";
const VALUE = "synthetic-private-read-after-withdrawal";
const LOCK = "opensesame:device-connectors";

function deferred() {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

/** Real ciphertext and crypto, with only the remote provider replaced. */
async function fixture() {
  const locks = webLocksDouble();
  configureHost(createTestHost({ locks: overlapCast(locks) }));
  const email = "synthetic@example.test";
  const password = "synthetic master password";
  const keyBytes = randomBytes(64);
  const key = symmetricKey(keyBytes);
  const sealedKey = await encryptBytes(
    keyBytes,
    await stretchMasterKey(
      await masterKey(password, email, {
        kind: "pbkdf2",
        iterations: 5000,
      }),
    ),
  );
  const sealedSecret = await encryptBytes(new TextEncoder().encode(VALUE), key);
  const sealedName = await encryptBytes(
    new TextEncoder().encode("Synthetic account"),
    key,
  );
  let live = true;
  let afterCheck = () => undefined;
  let beforeItem: () => Promise<void> = async () => undefined;
  const fetch = vi.fn<typeof globalThis.fetch>(async (input) => {
    const url = String(input);
    if (url.endsWith("/connect/token"))
      return Response.json({
        access_token: "synthetic-bearer-only-for-this-test",
        Key: sealedKey,
        Kdf: 0,
        KdfIterations: 5000,
      });
    if (url.endsWith(`/ciphers/${ITEM}`)) {
      await beforeItem();
      return Response.json({
        Id: ITEM,
        Type: 1,
        Name: sealedName,
        Login: { Password: sealedSecret },
        OrganizationId: null,
        DeletedDate: null,
      });
    }
    throw new Error("Unexpected synthetic provider request");
  });
  const transport = {
    fetch,
    assertCurrent() {
      if (!live) throw new Error("Original transport retired");
      afterCheck();
    },
  };
  const saved = await bitwardenVaultKeyFlows.configure(
    {
      providerId: "bitwarden",
      displayName: "Synthetic vault",
      parameters: { site: "us" },
      credentials: {
        email,
        master_password: password,
        client_id: "user.3f2a1b0c-9d8e-4f7a-8b6c-5d4e3f2a1b0c",
        client_secret: "AbCdEf0123456789GhIjKlMn",
      },
    },
    transport,
  );
  fetch.mockClear();
  return {
    locks,
    fetch,
    sealedSecret,
    retire: () => {
      live = false;
    },
    beforeItem: (run: () => Promise<void>) => {
      beforeItem = run;
    },
    afterCheck: (run: () => undefined) => {
      afterCheck = run;
    },
    read: (
      operation: "provider.item.read" | "provider.read" = "provider.item.read",
    ) =>
      bitwardenVaultKeyFlows.invoke(
        saved.connectionId,
        operation,
        operation === "provider.read" ? {} : { item: ITEM },
        transport,
      ),
  };
}

it("returns the actual decrypted value while its original transport stays current", async () => {
  const state = await fixture();
  const result = await state.read();
  expect(result.items).toEqual([
    { id: ITEM, label: "Synthetic account", secretValue: VALUE },
  ]);
  expect(state.fetch).toHaveBeenCalledTimes(2);
});

it("refuses a withdrawn transport before reading the private ledger or sending a request", async () => {
  const state = await fixture();
  const requested = state.locks.requested.length;
  state.retire();
  await expect(state.read()).rejects.toThrow("Original transport retired");
  expect(state.fetch).not.toHaveBeenCalled();
  expect(state.locks.requested).toHaveLength(requested);
});

it("refuses plaintext when the original transport ends during real item decryption", async () => {
  const state = await fixture();
  const wanted = Buffer.from(state.sealedSecret.split("|")[1] ?? "", "base64");
  const entered = deferred();
  const release = deferred();
  const original = crypto.subtle.decrypt.bind(crypto.subtle);
  const spy = vi
    .spyOn(crypto.subtle, "decrypt")
    .mockImplementation(async (algorithm, key, data) => {
      const decrypted = await original(algorithm, key, data);
      const bytes = ArrayBuffer.isView(data)
        ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength)
        : new Uint8Array(data);
      if (Buffer.from(bytes).equals(wanted)) {
        entered.resolve();
        await release.promise;
      }
      return decrypted;
    });
  try {
    const pending = state.read();
    await entered.promise;
    state.retire();
    release.resolve();
    await expect(pending).rejects.toThrow("Original transport retired");
  } finally {
    release.resolve();
    spy.mockRestore();
  }
});

it("refuses a result when its transport ends behind the final real revision lock", async () => {
  const state = await fixture();
  const entered = deferred();
  const release = deferred();
  const requested = state.locks.requested.filter(
    (name) => name === LOCK,
  ).length;
  let blocker: Promise<void> = Promise.resolve();
  state.beforeItem(async () => {
    blocker = state.locks.request(LOCK, async () => {
      entered.resolve();
      await release.promise;
    });
    await entered.promise;
  });
  try {
    const pending = state.read();
    await entered.promise;
    await vi.waitFor(() => {
      // Admission, our held lock, then the final revision read queued behind it.
      expect(
        state.locks.requested.filter((name) => name === LOCK),
      ).toHaveLength(requested + 3);
    });
    state.retire();
    release.resolve();
    await expect(pending).rejects.toThrow("Original transport retired");
  } finally {
    release.resolve();
    await blocker;
  }
});

it.each(["provider.item.read", "provider.read"] as const)(
  "rechecks the owner after the public %s awaits its bounded result",
  async (operation) => {
    const state = await fixture();
    const requested = state.locks.requested.filter(
      (name) => name === LOCK,
    ).length;
    let queued = false;
    state.afterCheck(() => {
      // Admission and the final revision read have both completed. This
      // check is truthful; withdrawal follows before the public await resumes.
      if (
        !queued &&
        state.locks.requested.filter((name) => name === LOCK).length ===
          requested + 2
      ) {
        queued = true;
        queueMicrotask(state.retire);
      }
      return undefined;
    });
    await expect(state.read(operation)).rejects.toThrow(
      "Original transport retired",
    );
    expect(queued).toBe(true);
  },
);
