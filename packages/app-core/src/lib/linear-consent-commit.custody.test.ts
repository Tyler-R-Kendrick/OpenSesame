/** Real device seals/default KV; only OPFS delivery and provider responses are doubled. */
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { z } from "zod";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { webLocksDouble } from "./__tests__/web-locks-double.js";
import { atRestReady } from "./at-rest/key.js";
import { openOriginFile } from "./at-rest/origin-files.js";
import {
  DEVICE_CONNECTOR_KEYS,
  readDeviceRows,
  readDeviceSecrets,
} from "./device-connector-records.js";
import { deviceConnection } from "./device-connectors.js";
import { kvFileName, kvFlush, kvForgetAll, kvHydrate } from "./kv.js";
import { linearApiSeams } from "./linear-api.js";
import {
  configureLinearConnector,
  finishLinearAuthorization,
} from "./linear-connectors.js";
import {
  linearAccount,
  linearAnswers,
  linearDraft,
  linearOptions,
  linearToken,
  pendingLinear,
} from "./linear-runtime.test-support.js";
import { linearGrant, readLinearConnector } from "./linear-store.js";
import {
  fixture,
  restoreOriginPublicationFixture,
} from "./origin-file-publication-custody.test-support.js";

const atomicFile = kvFileName(DEVICE_CONNECTOR_KEYS[2]);
const Ledger = z.record(
  z.string(),
  z.object({ secrets: z.record(z.string(), z.string()) }).nullable(),
);
function deferred() {
  let release = () => {};
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
function stagedConsent() {
  const entered = deferred();
  const resumed = deferred();
  const counts = { close: 0, abort: 0 };
  let captured = false;
  let id = "";
  let staged = "";
  const delivery = fixture((stream) => {
    const write = stream.write;
    const close = stream.close;
    const abort = stream.abort;
    let selected = false;
    stream.write = async (value) => {
      await write(value);
      const wire = z.string().safeParse(value);
      if (captured || !id || !wire.success) return;
      const opened = await openOriginFile(atomicFile, wire.data);
      if (!opened) return;
      const candidate = Ledger.parse(JSON.parse(opened))[id];
      if (!candidate?.secrets.linear_app_grant) return;
      captured = true;
      selected = true;
      staged = wire.data;
      entered.release();
      await resumed.promise;
    };
    stream.close = async () => {
      if (selected) counts.close += 1;
      await close();
    };
    stream.abort = async () => {
      if (selected) counts.abort += 1;
      await abort();
    };
  });
  return {
    delivery,
    counts,
    entered: entered.promise,
    resume: resumed.release,
    arm(connectionId: string) {
      id = connectionId;
    },
    staged: () => staged,
  };
}
type Stage = ReturnType<typeof stagedConsent>;
let stage: Stage;
const originalFetch = linearApiSeams.fetch;
beforeEach(async () => {
  kvForgetAll();
  stage = stagedConsent();
  configureHost(
    createTestHost({
      ...stage.delivery.installed,
      env: { BASE_URL: "/OpenSesame/" },
      locks: overlapCast(webLocksDouble()),
      page: overlapCast({
        location: {
          origin: "https://app.example.org",
          href: "https://app.example.org/OpenSesame/",
          assign: vi.fn(),
        },
        replaceUrl: vi.fn(),
      }),
    }),
  );
  expect((await atRestReady()).durable).toBe(true);
});
afterEach(async () => {
  stage.resume();
  await kvFlush();
  linearApiSeams.fetch = originalFetch;
  restoreOriginPublicationFixture();
  kvForgetAll();
});

async function consent(cleanupFails = false) {
  const saved = await configureLinearConnector(
    linearDraft("oauth"),
    linearOptions,
  );
  const transaction = pendingLinear(saved.connectionId);
  const provider = linearAnswers(
    { body: linearToken },
    { body: { data: linearAccount } },
    { body: null, status: cleanupFails ? 503 : 200 },
    { body: null },
  );
  stage.arm(saved.connectionId);
  let current = true;
  const check = () => {
    if (!current) throw new Error("Original Linear owner withdrew");
  };
  const pending = finishLinearAuthorization(
    `?linear_state=${transaction.state}&linear_code=one-time-code`,
    check,
  );
  const outcome = pending.then(
    (value) => ({ value, error: null }),
    (error: Error) => ({ value: null, error }),
  );
  await stage.entered;
  return {
    id: saved.connectionId,
    transaction,
    provider,
    outcome,
    withdraw() {
      current = false;
    },
  };
}
function revoked(provider: ReturnType<typeof linearAnswers>): string[] {
  return provider.mock.calls.flatMap(([url, init]) =>
    String(url).endsWith("/oauth/revoke")
      ? [new URLSearchParams(String(init?.body)).get("token") ?? ""]
      : [],
  );
}
async function coldRead() {
  await kvFlush();
  kvForgetAll();
  await kvHydrate([...DEVICE_CONNECTOR_KEYS]);
}
function expectUninstalled(id: string) {
  expect.soft(linearGrant(id, "app")).toBeNull();
  expect.soft(readLinearConnector(id)?.app).toBeNull();
  expect.soft(deviceConnection(id)?.status).not.toBe("active");
}
function expectSealedOnly(transaction: { verifier: string }) {
  const publicText = JSON.stringify(readDeviceRows());
  const wires = [...stage.delivery.files.values()].join("");
  for (const secret of [
    linearToken.access_token,
    linearToken.refresh_token,
    transaction.verifier,
  ]) {
    expect.soft(publicText).not.toContain(secret);
    expect.soft(wires).not.toContain(secret);
  }
}

it("aborts the actual staged seal before close and compensates a withdrawn consent", async () => {
  const attempt = await consent();
  expect(linearGrant(attempt.id, "app")).toBeNull();
  const predecessor = stage.delivery.files.get(atomicFile);
  expect(predecessor).toBeTruthy();
  expect(stage.staged()).not.toBe(predecessor);
  expect(stage.counts).toEqual({ close: 0, abort: 0 });
  attempt.withdraw();
  stage.resume();
  const result = await attempt.outcome;
  expect.soft(result.error).toMatchObject({
    message: "Original Linear owner withdrew",
  });
  expect.soft(stage.counts).toEqual({ close: 0, abort: 1 });
  expectUninstalled(attempt.id);
  expect
    .soft(revoked(attempt.provider))
    .toEqual([linearToken.refresh_token, linearToken.access_token]);
  expect
    .soft(readDeviceSecrets()[attempt.id]?.linear_cleanup_app)
    .toBeUndefined();
  await coldRead();
  expectUninstalled(attempt.id);
  expectSealedOnly(attempt.transaction);
});

it("retains rejected grant custody when provider compensation fails", async () => {
  const attempt = await consent(true);
  attempt.withdraw();
  stage.resume();
  const result = await attempt.outcome;
  expect.soft(result.error).toMatchObject({
    message: expect.stringContaining("provider cleanup failed"),
  });
  expect.soft(stage.counts).toEqual({ close: 0, abort: 1 });
  expectUninstalled(attempt.id);
  expect.soft(revoked(attempt.provider)).toEqual([linearToken.refresh_token]);
  await coldRead();
  expectUninstalled(attempt.id);
  const queue = readDeviceSecrets()[attempt.id]?.linear_cleanup_app;
  expect(queue).toBeDefined();
  expect(JSON.parse(queue ?? "null")).toEqual([
    expect.objectContaining({
      accessToken: linearToken.access_token,
      refreshToken: linearToken.refresh_token,
    }),
  ]);
  expectSealedOnly(attempt.transaction);
});

it("closes and cold-loads the same staged grant when its original owner remains current", async () => {
  const attempt = await consent();
  stage.resume();
  const result = await attempt.outcome;
  expect(result.error).toBeNull();
  expect(result.value?.status).toBe("active");
  expect(stage.counts).toEqual({ close: 1, abort: 0 });
  expect(revoked(attempt.provider)).toEqual([]);
  await coldRead();
  expect(linearGrant(attempt.id, "app")?.accessToken).toBe(
    linearToken.access_token,
  );
  expect(deviceConnection(attempt.id)?.status).toBe("active");
  expectSealedOnly(attempt.transaction);
});
