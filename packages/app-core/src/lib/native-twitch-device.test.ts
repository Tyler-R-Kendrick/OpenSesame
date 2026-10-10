import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { forgetAtRestKeyForTest } from "./at-rest/key.js";
import {
  readDeviceRows,
  subscribeDeviceRows,
} from "./device-connector-records.js";
import * as kv from "./kv.js";
import { removeNativeConnectorWithCleanup } from "./native-connector-lifecycle.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";
import { beginNativeTwitchDeviceAuthorization } from "./native-twitch-device.js";
import {
  access,
  backend,
  challenge,
  clientId,
  configured,
  deviceCode,
  disposers,
  refresh,
  runtime,
  token,
} from "./native-twitch-device.test-support.js";

beforeEach(kv.kvForgetAll);
afterEach(() => {
  for (const dispose of disposers.splice(0).reverse()) dispose();
  vi.restoreAllMocks();
  configureHost(createTestHost());
  forgetAtRestKeyForTest();
});
it("authenticates a public Twitch client, proves its Helix user, restores sealed access, and revokes only the documented access token", async () => {
  const reload = backend();
  const session = runtime();
  const saved = await configured();
  await beginNativeTwitchDeviceAuthorization(
    saved.connectionId,
    "user",
    async (delay, signal) => {
      expect(readNativeConnector(saved.connectionId)?.status).toBe(
        "authorizing",
      );
      expect(
        loadNativeConnectorRecord(saved.connectionId)?.privateState.pending.user
          ?.verifier,
      ).toContain(deviceCode);
      expect(JSON.stringify(readDeviceRows())).not.toContain(deviceCode);
      await session.wait(delay, signal);
    },
  );
  const view = readNativeConnector(saved.connectionId);
  expect(view).toMatchObject({
    status: "connected",
    identity: { id: "12345" },
  });
  const deviceForm = new URLSearchParams(
    String(session.fetcher.mock.calls[0]?.[1]?.body),
  );
  expect(deviceForm.get("client_id")).toBe(clientId);
  expect(deviceForm.has("client_secret")).toBe(false);
  const pollForm = new URLSearchParams(
    String(session.fetcher.mock.calls[1]?.[1]?.body),
  );
  expect(pollForm.get("grant_type")).toBe(
    "urn:ietf:params:oauth:grant-type:device_code",
  );
  expect(pollForm.get("device_code")).toBe(deviceCode);
  expect(pollForm.has("client_secret")).toBe(false);
  expect(session.consent.mock.calls[0]?.[0]).toMatchObject({
    verificationUri: challenge.verification_uri,
    userCode: "ABCDEFGH",
  });
  const helix = session.fetcher.mock.calls.find(([url]) =>
    String(url).includes("/helix/users"),
  );
  expect(new Headers(helix?.[1]?.headers).get("Client-Id")).toBe(clientId);
  expect(new Headers(helix?.[1]?.headers).get("authorization")).toBe(
    `Bearer ${access}`,
  );
  expect(JSON.stringify(view)).not.toContain(access);
  expect(JSON.stringify(readDeviceRows())).not.toContain(refresh);
  reload();
  expect(readNativeConnector(saved.connectionId)?.status).toBe("connected");
  expect(await removeNativeConnectorWithCleanup(saved.connectionId)).toBe(true);
  const revokes = session.fetcher.mock.calls.filter(([url]) =>
    String(url).endsWith("/revoke"),
  );
  expect(revokes).toHaveLength(1);
  expect(new URLSearchParams(String(revokes[0]?.[1]?.body)).get("token")).toBe(
    access,
  );
  expect(readNativeConnector(saved.connectionId)).toBeNull();
});
it("honors authorization_pending and increases every subsequent polling interval after slow_down", async () => {
  backend();
  const session = runtime();
  const saved = await configured();
  session.fetcher.mockResolvedValueOnce(Response.json(challenge));
  session.fetcher.mockResolvedValueOnce(
    Response.json(
      { status: 400, message: "authorization_pending" },
      { status: 400 },
    ),
  );
  session.fetcher.mockResolvedValueOnce(
    Response.json({ error: "slow_down" }, { status: 400 }),
  );
  session.fetcher.mockResolvedValueOnce(Response.json(token));
  await beginNativeTwitchDeviceAuthorization(
    saved.connectionId,
    "user",
    session.wait,
  );
  expect(session.waits).toEqual([5000, 5000, 10000]);
  expect(readNativeConnector(saved.connectionId)?.status).toBe("connected");
});
it("expires a finite device request without continuing to poll or reporting connected", async () => {
  backend();
  const session = runtime();
  const saved = await configured();
  session.fetcher.mockResolvedValueOnce(
    Response.json({ ...challenge, expires_in: 8 }),
  );
  session.fetcher.mockResolvedValueOnce(
    Response.json({ message: "authorization_pending" }, { status: 400 }),
  );
  await expect(
    beginNativeTwitchDeviceAuthorization(
      saved.connectionId,
      "user",
      session.wait,
    ),
  ).rejects.toThrow("expired");
  expect(session.waits).toEqual([5000, 3000]);
  expect(session.fetcher).toHaveBeenCalledTimes(2);
  expect(readNativeConnector(saved.connectionId)?.status).toBe("configuration");
  expect(
    loadNativeConnectorRecord(saved.connectionId)?.privateState.pending,
  ).toEqual({});
});
it("cancels before minting without leaving a blocked device request", async () => {
  backend();
  const session = runtime();
  const saved = await configured();
  await expect(
    beginNativeTwitchDeviceAuthorization(
      saved.connectionId,
      "user",
      async () => {
        session.controller.abort();
      },
    ),
  ).rejects.toThrow("declined");
  expect(session.fetcher).toHaveBeenCalledTimes(1);
  expect(
    loadNativeConnectorRecord(saved.connectionId)?.privateState.pending,
  ).toEqual({});
  expect(
    loadNativeConnectorRecord(saved.connectionId)?.privateState.recovery,
  ).toEqual([]);
});
it("retains and revokes the minted access token when the user cancels during its reply", async () => {
  backend();
  const session = runtime();
  const saved = await configured();
  session.fetcher.mockResolvedValueOnce(Response.json(challenge));
  session.fetcher.mockImplementationOnce(async () => {
    session.controller.abort();
    return Response.json(token);
  });
  await expect(
    beginNativeTwitchDeviceAuthorization(
      saved.connectionId,
      "user",
      session.wait,
    ),
  ).rejects.toThrow("expired");
  expect(
    session.fetcher.mock.calls.some(([url]) => String(url).endsWith("/revoke")),
  ).toBe(true);
  expect(
    loadNativeConnectorRecord(saved.connectionId)?.privateState.grants,
  ).toEqual({});
  expect(
    loadNativeConnectorRecord(saved.connectionId)?.privateState.pending,
  ).toEqual({});
  expect(readNativeConnector(saved.connectionId)?.status).toBe("configuration");
});
it("keeps an issued token durably recoverable after capability disposal during the mint reply", async () => {
  backend();
  const session = runtime();
  const saved = await configured();
  session.fetcher.mockResolvedValueOnce(Response.json(challenge));
  session.fetcher.mockImplementationOnce(async () => {
    session.dispose();
    return Response.json(token);
  });
  await expect(
    beginNativeTwitchDeviceAuthorization(
      saved.connectionId,
      "user",
      session.wait,
    ),
  ).rejects.toThrow("disposed");
  expect(
    loadNativeConnectorRecord(saved.connectionId)?.privateState.recovery[0]
      ?.grant?.accessToken,
  ).toBe(access);
  expect(readNativeConnector(saved.connectionId)?.status).toBe("cleanup");
  expect(JSON.stringify(readDeviceRows())).not.toContain(access);
});
it("records a lost token reply honestly and permits a fresh request", async () => {
  backend();
  const session = runtime();
  const saved = await configured();
  session.fetcher.mockResolvedValueOnce(Response.json(challenge));
  session.fetcher.mockRejectedValueOnce(new Error("Lost token response"));
  await expect(
    beginNativeTwitchDeviceAuthorization(
      saved.connectionId,
      "user",
      session.wait,
    ),
  ).rejects.toThrow("reached");
  const view = readNativeConnector(saved.connectionId);
  expect(view?.configuration.parameters.authorization_outcome).toBe(
    "exchange-unobserved",
  );
  expect(view?.status).toBe("configuration");
  expect(
    session.fetcher.mock.calls.some(([url]) => String(url).endsWith("/revoke")),
  ).toBe(false);
  await beginNativeTwitchDeviceAuthorization(
    saved.connectionId,
    "user",
    session.wait,
  );
  expect(readNativeConnector(saved.connectionId)?.status).toBe("connected");
  expect(
    readNativeConnector(saved.connectionId)?.configuration.parameters
      .authorization_outcome,
  ).toBeUndefined();
});
it("does not revoke the active connection when device reauthorization reuses its access credential", async () => {
  backend();
  const session = runtime();
  const saved = await configured();
  await beginNativeTwitchDeviceAuthorization(
    saved.connectionId,
    "user",
    session.wait,
  );
  const previousRevision = readNativeConnector(saved.connectionId)?.revision;
  await beginNativeTwitchDeviceAuthorization(
    saved.connectionId,
    "user",
    session.wait,
  );
  expect(readNativeConnector(saved.connectionId)?.status).toBe("connected");
  expect(readNativeConnector(saved.connectionId)?.revision).toBeGreaterThan(
    previousRevision ?? 0,
  );
  expect(
    session.fetcher.mock.calls.some(([url]) => String(url).endsWith("/revoke")),
  ).toBe(false);
});
it("commits verified authority and device-code consumption together before a later storage failure", async () => {
  const reload = backend();
  const session = runtime();
  const saved = await configured();
  const release = subscribeDeviceRows(() => {
    if (readNativeConnector(saved.connectionId)?.status === "connected")
      vi.mocked(kv.kvSeams.kvSetDurable).mockRejectedValueOnce(
        new Error("Device storage became full after activation"),
      );
  });
  try {
    await beginNativeTwitchDeviceAuthorization(
      saved.connectionId,
      "user",
      session.wait,
    );
  } finally {
    release();
  }
  reload();
  expect(readNativeConnector(saved.connectionId)?.status).toBe("connected");
  expect(
    loadNativeConnectorRecord(saved.connectionId)?.privateState.pending,
  ).toEqual({});
});
