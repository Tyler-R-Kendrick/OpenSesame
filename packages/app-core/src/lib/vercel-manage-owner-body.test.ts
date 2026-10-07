import { expect, it, vi } from "vitest";
import { configureHost, host } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { kvDelete } from "./kv.js";
import { enrollRetiredCredential } from "./retired-credentials/index.js";
import { flushRetiredCredentialTelemetry } from "./retired-credentials/telemetry-queue.js";
import { unlockWithRetiredCredentialGate } from "./retired-credentials/unlock.js";
import { clearVaultSurface } from "./vault/protection/protector-enrollment.test-support.js";
import { vaultStore } from "./vault/store.js";
import { readConnector } from "./vercel-connect-manage.js";
import { setVercelConnectAuth, vercelConnectSeams } from "./vercel-connect.js";
import { tombFileKey } from "./vfs.js";

it("real configured connector details are withheld across a held response body and require fresh owner transport admission", async () => {
  const originalHost = host();
  const originalFetch = vercelConnectSeams.fetch;
  const password = "configured-connector-owner-proof";
  const retired = "configured-connector-retired-proof";
  let created = false;
  let resume = () => {};
  let finished: Promise<void> | undefined;
  configureHost(createTestHost({ locks: webLocksDouble() }));
  try {
    await clearVaultSurface();
    kvDelete(tombFileKey("personal", "retired-credentials.v1"));
    await vaultStore.create(password);
    created = true;
    await enrollRetiredCredential({
      tomb: "personal",
      currentPassword: password,
      retiredPassword: retired,
      response: "synthetic_decoy",
      acknowledgePasswordVerifierRisk: true,
    });
    setVercelConnectAuth({ token: "controlled-no-vendor-test-token" });
    const details = {
      id: "scl_fixture",
      name: "Controlled connector",
      data: {
        clientId: "controlled-client",
        serverUrl: "https://controlled.example.test/mcp",
      },
    };
    const requests: RequestInit[] = [];
    vercelConnectSeams.fetch = async (_url, init) => {
      requests.push(init ?? {});
      return Response.json(details);
    };
    expect(await readConnector("scl_fixture")).toMatchObject({
      clientId: "controlled-client",
    });
    expect(requests[0]?.credentials).toBe("omit");
    let started = () => {};
    const bodyStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const barrier = new Promise<void>((resolve) => {
      resume = resolve;
    });
    vercelConnectSeams.fetch = async () =>
      new Response(
        new ReadableStream(
          {
            async pull(controller) {
              started();
              await barrier;
              controller.enqueue(
                new TextEncoder().encode(JSON.stringify(details)),
              );
              controller.close();
            },
          },
          { highWaterMark: 0 },
        ),
      );
    const pending = readConnector("scl_fixture").then(
      (value) => ({ accepted: true as const, value }),
      (error) => ({ accepted: false as const, error }),
    );
    finished = pending.then(() => {});
    await bodyStarted;
    vaultStore.lock();
    await unlockWithRetiredCredentialGate(vaultStore, retired);
    vaultStore.lock();
    resume();
    expect((await pending).accepted).toBe(false);
    await expect(readConnector("scl_fixture")).rejects.toThrow();
    await vaultStore.unlock(password);
    setVercelConnectAuth({ token: "controlled-new-owner-token" });
    vercelConnectSeams.fetch = async () => new Response("{", { status: 200 });
    await expect(readConnector("scl_fixture")).rejects.toMatchObject({
      code: "malformed",
    });
    vercelConnectSeams.fetch = async () => Response.json(details);
    expect(await readConnector("scl_fixture")).toMatchObject({
      clientId: "controlled-client",
    });
  } finally {
    resume();
    try {
      await finished;
      await flushRetiredCredentialTelemetry();
      if (created) {
        vaultStore.lock();
        await vaultStore.unlock(password);
        vaultStore.lock();
      }
    } finally {
      setVercelConnectAuth(null);
      vercelConnectSeams.fetch = originalFetch;
      configureHost(originalHost);
      vi.restoreAllMocks();
    }
  }
});
