import { expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { deviceIdentitySeams } from "./device-identity.js";
import { identitySeams } from "./identity.js";
import { kvDelete } from "./kv.js";
import { enrollRetiredCredential } from "./retired-credentials/index.js";
import { flushRetiredCredentialTelemetry } from "./retired-credentials/telemetry-queue.js";
import { unlockWithRetiredCredentialGate } from "./retired-credentials/unlock.js";
import { clearVaultSurface } from "./vault/protection/protector-enrollment.test-support.js";
import { vaultStore } from "./vault/store.js";
import { tombFileKey } from "./vfs.js";
import {
  disableWalletLauncher,
  listWalletRegistrations,
  registerWalletLauncher,
} from "./wallet-registration.js";

const password = "wallet-current-owner-proof";
const retired = "wallet-retired-synthetic-proof";
const registration = {
  registrationId: "owner-registration",
  state: "active",
  passId: "owner-pass",
  createdAt: "2026-10-07T00:00:00Z",
};
const saveUrl = "https://wallet.example.test/save/owner-private-fixture";
const operations = [
  {
    name: "register",
    invoke: () =>
      registerWalletLauncher({
        registrationId: registration.registrationId,
        header: "Owner",
      }),
    body: {
      ...registration,
      saveUrl,
      reissued: false,
      rotatingBarcodeProvisioned: false,
    },
  },
  {
    name: "list",
    invoke: () => listWalletRegistrations(),
    body: { registrations: [registration] },
  },
  {
    name: "disable",
    invoke: () => disableWalletLauncher(registration.registrationId),
    body: { ...registration, state: "disabled", googleAcknowledged: true },
  },
];

it.each(operations)(
  "withholds the $name body from an expired original owner epoch",
  async ({ invoke, body }) => {
    configureHost(createTestHost({ locks: webLocksDouble() }));
    await clearVaultSurface();
    kvDelete(tombFileKey("personal", "retired-credentials.v1"));
    const originalRemote = deviceIdentitySeams.remoteIdentityApi;
    deviceIdentitySeams.remoteIdentityApi = () =>
      "https://identity.example.test";
    let stream: ReadableStreamDefaultController<Uint8Array> | undefined;
    let bodyReadStarted = false;
    let closeStream = () => {};
    let settled: Promise<void> | undefined;
    const transport = vi
      .spyOn(identitySeams, "identityFetch")
      .mockImplementation(async () => Response.json(body));
    try {
      await vaultStore.create(password);
      await vaultStore.flushPendingWrites();
      await enrollRetiredCredential({
        tomb: "personal",
        currentPassword: password,
        retiredPassword: retired,
        response: "synthetic_decoy",
        acknowledgePasswordVerifierRisk: true,
      });
      const positive = await invoke();
      expect(positive).toBeDefined();
      transport.mockImplementationOnce(
        async () =>
          new Response(
            new ReadableStream<Uint8Array>(
              {
                start(controller) {
                  stream = controller;
                },
                pull() {
                  bodyReadStarted = true;
                },
              },
              { highWaterMark: 0 },
            ),
            { headers: { "content-type": "application/json" } },
          ),
      );
      let closed = false;
      closeStream = () => {
        if (closed || !stream) return;
        closed = true;
        stream.enqueue(new TextEncoder().encode(JSON.stringify(body)));
        stream.close();
      };
      // Attach both outcomes immediately: the RED path is an accepted stale body,
      // not an unhandled rejection or an abandoned memory-hard credential check.
      const verdict = invoke().then(
        (value) => ({ accepted: true, value }),
        (error) => ({ accepted: false, error }),
      );
      settled = verdict.then(() => {});
      await vi.waitFor(() => expect(bodyReadStarted).toBe(true));
      vaultStore.lock();
      await unlockWithRetiredCredentialGate(vaultStore, retired);
      expect(vaultStore.getSnapshot().guest).toBe(true);
      expect(
        vaultStore
          .getSnapshot()
          .items.some((item) => JSON.stringify(item).includes(saveUrl)),
      ).toBe(false);
      vaultStore.lock();
      closeStream();
      expect((await verdict).accepted).toBe(false);
      const calls = transport.mock.calls.length;
      await expect(invoke()).rejects.toThrow();
      expect(transport.mock.calls).toHaveLength(calls);
      await flushRetiredCredentialTelemetry();
      await vaultStore.unlock(password);
      expect(await invoke()).toEqual(positive);
      transport.mockImplementationOnce(
        async () =>
          new Response("not JSON", {
            headers: { "content-type": "application/json" },
          }),
      );
      await expect(invoke()).rejects.toThrow();
      // Failed parsing must leave the next fresh owner's operation usable.
      expect(await invoke()).toEqual(positive);
    } finally {
      closeStream();
      await settled;
      await flushRetiredCredentialTelemetry();
      vaultStore.lock();
      // Also runs on causal RED, restoring the original owner's genuine proof
      // before resetting transport ports so a pending latch cannot contaminate peers.
      if (vaultStore.getSnapshot().status !== "empty") {
        await vaultStore.unlock(password);
        vaultStore.lock();
      }
      vi.restoreAllMocks();
      deviceIdentitySeams.remoteIdentityApi = originalRemote;
    }
  },
);
