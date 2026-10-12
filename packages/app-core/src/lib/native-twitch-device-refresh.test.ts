import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { forgetAtRestKeyForTest } from "./at-rest/key.js";
import * as kv from "./kv.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";
import { retryRetainedNativeOAuthGrants } from "./native-oauth-session.js";
import { refreshNativeTwitchAuthorization } from "./native-twitch-device-refresh.js";
import { beginNativeTwitchDeviceAuthorization } from "./native-twitch-device.js";
import {
  access,
  backend,
  clientId,
  configured,
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
async function signedIn() {
  backend();
  const session = runtime();
  const saved = await configured();
  await beginNativeTwitchDeviceAuthorization(
    saved.connectionId,
    "user",
    session.wait,
  );
  const record = loadNativeConnectorRecord(saved.connectionId);
  if (!record) throw new Error("Missing Twitch connection");
  return { ...session, id: saved.connectionId, record };
}
it("seals a one-use refreshed pair before verification and revokes the still-valid old access token", async () => {
  const session = await signedIn();
  const rotated = {
    ...token,
    access_token: "test-rotated-access",
    refresh_token: "test-rotated-one-use-refresh",
  };
  session.fetcher.mockImplementationOnce(async (_url, init) => {
    const form = new URLSearchParams(String(init?.body));
    expect(form.get("grant_type")).toBe("refresh_token");
    expect(form.get("refresh_token")).toBe(refresh);
    expect(form.get("client_id")).toBe(clientId);
    expect(form.has("client_secret")).toBe(false);
    const retainedOld = loadNativeConnectorRecord(
      session.id,
    )?.privateState.recovery.filter(
      (entry) => entry.grant?.accessToken === access,
    );
    expect(retainedOld).toHaveLength(2);
    return Response.json(rotated);
  });
  await refreshNativeTwitchAuthorization(session.record, session.transport);
  expect(readNativeConnector(session.id)?.status).toBe("connected");
  expect(
    loadNativeConnectorRecord(session.id)?.privateState.grants.user,
  ).toMatchObject({
    accessToken: rotated.access_token,
    refreshToken: rotated.refresh_token,
  });
  const revokes = session.fetcher.mock.calls.filter(([url]) =>
    String(url).endsWith("/revoke"),
  );
  expect(revokes).toHaveLength(1);
  expect(new URLSearchParams(String(revokes[0]?.[1]?.body)).get("token")).toBe(
    access,
  );
});
it("preserves both known access tokens for actual revocation when disposal interrupts rotated token verification", async () => {
  const session = await signedIn();
  const rotated = {
    ...token,
    access_token: "test-rotated-access",
    refresh_token: "test-rotated-refresh",
  };
  session.fetcher.mockImplementationOnce(async () => {
    session.dispose();
    return Response.json(rotated);
  });
  await expect(
    refreshNativeTwitchAuthorization(session.record, session.transport),
  ).rejects.toThrow("disposed");
  const grants = loadNativeConnectorRecord(
    session.id,
  )?.privateState.recovery.map((entry) => entry.grant?.accessToken);
  expect(grants).toContain(access);
  expect(grants).toContain(rotated.access_token);
  expect(readNativeConnector(session.id)?.status).toBe("cleanup");
});
it("does not claim a lost refresh reply was revoked and still revokes the old observed access token", async () => {
  const session = await signedIn();
  session.fetcher.mockRejectedValueOnce(
    new Error("Lost rotated pair response"),
  );
  await expect(
    refreshNativeTwitchAuthorization(session.record, session.transport),
  ).rejects.toThrow("reached");
  expect(
    readNativeConnector(session.id)?.configuration.parameters
      .authorization_outcome,
  ).toBe("refresh-unobserved");
  expect(loadNativeConnectorRecord(session.id)?.privateState.grants).toEqual(
    {},
  );
  expect(readNativeConnector(session.id)?.status).toBe("configuration");
  const revokes = session.fetcher.mock.calls.filter(([url]) =>
    String(url).endsWith("/revoke"),
  );
  expect(
    revokes.every(
      ([, init]) =>
        new URLSearchParams(String(init?.body)).get("token") === access,
    ),
  ).toBe(true);
});
it("does not revoke a provider's reused access credential after storing its new refresh token", async () => {
  const session = await signedIn();
  session.fetcher.mockResolvedValueOnce(
    Response.json({ ...token, refresh_token: "test-rotated-one-use-refresh" }),
  );
  await refreshNativeTwitchAuthorization(session.record, session.transport);
  expect(readNativeConnector(session.id)?.status).toBe("connected");
  expect(
    loadNativeConnectorRecord(session.id)?.privateState.grants.user
      ?.refreshToken,
  ).toBe("test-rotated-one-use-refresh");
  expect(
    session.fetcher.mock.calls.some(([url]) => String(url).endsWith("/revoke")),
  ).toBe(false);
});
it("immediately compensates both observed access tokens if sealing a one-use rotated pair fails", async () => {
  const session = await signedIn();
  const rotated = {
    ...token,
    access_token: "test-unsealed-rotated-access",
    refresh_token: "test-unsealed-rotated-refresh",
  };
  session.fetcher.mockImplementationOnce(async () => {
    vi.mocked(kv.kvSeams.kvSetDurable).mockRejectedValueOnce(
      new Error("Device storage full"),
    );
    return Response.json(rotated);
  });
  await expect(
    refreshNativeTwitchAuthorization(session.record, session.transport),
  ).rejects.toThrow("could not be sealed");
  const revoked = session.fetcher.mock.calls
    .filter(([url]) => String(url).endsWith("/revoke"))
    .map(([, init]) => new URLSearchParams(String(init?.body)).get("token"));
  expect(revoked).toContain(rotated.access_token);
  expect(revoked).toContain(access);
  expect(loadNativeConnectorRecord(session.id)?.privateState.grants).toEqual(
    {},
  );
  expect(loadNativeConnectorRecord(session.id)?.privateState.recovery).toEqual(
    [],
  );
  expect(readNativeConnector(session.id)?.status).toBe("configuration");
});
it("preserves retryable rotated credentials if storage failure and disposal also prevent immediate compensation", async () => {
  const session = await signedIn();
  const rotated = {
    ...token,
    access_token: "test-recoverable-rotated-access",
    refresh_token: "test-recoverable-rotated-refresh",
  };
  session.fetcher.mockImplementationOnce(async () => {
    vi.mocked(kv.kvSeams.kvSetDurable).mockRejectedValueOnce(
      new Error("Device storage full"),
    );
    session.dispose();
    return Response.json(rotated);
  });
  await expect(
    refreshNativeTwitchAuthorization(session.record, session.transport),
  ).rejects.toThrow("disposed");
  await retryRetainedNativeOAuthGrants(session.id);
  const retained = loadNativeConnectorRecord(session.id)?.privateState.recovery;
  expect(retained?.map((entry) => entry.grant?.accessToken)).toContain(
    rotated.access_token,
  );
  expect(retained?.map((entry) => entry.grant?.accessToken)).toContain(access);
  expect(readNativeConnector(session.id)?.status).toBe("cleanup");
});
