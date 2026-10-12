import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { configureHost } from "../host.js";
import { createTestHost } from "../test-host.js";
import { forgetAtRestKeyForTest } from "./at-rest/key.js";
import * as kv from "./kv.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";
import {
  parseNativeTwitchDeviceToken,
  requestNativeTwitchDevice,
} from "./native-twitch-device-http.js";
import { beginNativeTwitchDeviceAuthorization } from "./native-twitch-device.js";
import {
  access,
  backend,
  challenge,
  clientId,
  configured,
  disposers,
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
it.each([
  "https://evil.example/activate?device-code=ABCDEFGH",
  "https://www.twitch.tv/activate?device-code=OTHER",
  "https://www.twitch.tv/activate?public=false",
  "https://www.twitch.tv/activate?device-code=ABCDEFGH&device-code=ABCDEFGH",
  "https://www.twitch.tv/activate?device_code=ABCDEFGH",
  "https://www.twitch.tv/activate#access_token=private",
])(
  "refuses an unsafe or undocumented verification URI %s before opening consent",
  async (verification_uri) => {
    backend();
    const session = runtime();
    session.fetcher.mockResolvedValueOnce(
      Response.json({ ...challenge, verification_uri }),
    );
    await expect(
      requestNativeTwitchDevice(clientId, [], session.transport),
    ).rejects.toThrow("valid");
    expect(session.consent).not.toHaveBeenCalled();
  },
);
it("parses Twitch's array scopes and retains recognizable credentials when the protocol is invalid", () => {
  expect(parseNativeTwitchDeviceToken(token)).toMatchObject({
    accessToken: access,
    protocolValid: true,
    scopes: [],
  });
  expect(
    parseNativeTwitchDeviceToken({ ...token, token_type: "mac" }),
  ).toMatchObject({ accessToken: access, protocolValid: false });
  expect(
    parseNativeTwitchDeviceToken({ ...token, scope: "user:read:email" }),
  ).toMatchObject({ accessToken: access, protocolValid: false, scopes: null });
  expect(
    parseNativeTwitchDeviceToken({
      ...token,
      refresh_token: { invalid: true },
    }),
  ).toMatchObject({ accessToken: access, protocolValid: false });
});
it("uses Twitch's documented public-client prefill when the provider returns its bare activation page", async () => {
  backend();
  const session = runtime();
  session.fetcher.mockResolvedValueOnce(
    Response.json({
      ...challenge,
      verification_uri: "https://www.twitch.tv/activate",
    }),
  );
  const request = await requestNativeTwitchDevice(
    clientId,
    [],
    session.transport,
  );
  expect(request.verification_uri).toBe(challenge.verification_uri);
});
it("retains and compensates an issued access token even when its refresh field is malformed", async () => {
  backend();
  const session = runtime();
  const saved = await configured();
  session.fetcher.mockResolvedValueOnce(Response.json(challenge));
  session.fetcher.mockResolvedValueOnce(
    Response.json({ ...token, refresh_token: { invalid: true } }),
  );
  await expect(
    beginNativeTwitchDeviceAuthorization(
      saved.connectionId,
      "user",
      session.wait,
    ),
  ).rejects.toThrow("valid");
  expect(
    session.fetcher.mock.calls.some(([url]) => String(url).endsWith("/revoke")),
  ).toBe(true);
  expect(
    loadNativeConnectorRecord(saved.connectionId)?.privateState.grants,
  ).toEqual({});
  expect(readNativeConnector(saved.connectionId)?.status).toBe("configuration");
});
it("rejects a token validated for a different public client before calling Helix", async () => {
  backend();
  const session = runtime();
  const saved = await configured();
  session.fetcher.mockResolvedValueOnce(Response.json(challenge));
  session.fetcher.mockResolvedValueOnce(Response.json(token));
  session.fetcher.mockResolvedValueOnce(
    Response.json({
      client_id: "another-client",
      user_id: "12345",
      login: "engineer",
      scopes: [],
      expires_in: 14000,
    }),
  );
  await expect(
    beginNativeTwitchDeviceAuthorization(
      saved.connectionId,
      "user",
      session.wait,
    ),
  ).rejects.toThrow("valid");
  expect(
    session.fetcher.mock.calls.some(([url]) =>
      String(url).includes("/helix/users"),
    ),
  ).toBe(false);
  expect(readNativeConnector(saved.connectionId)?.status).toBe("configuration");
});
it("rejects fabricated scopes even if a recognizable access token was returned", async () => {
  backend();
  const session = runtime();
  const saved = await configured();
  session.fetcher.mockResolvedValueOnce(Response.json(challenge));
  session.fetcher.mockResolvedValueOnce(
    Response.json({ ...token, scope: ["channel:manage:broadcast"] }),
  );
  await expect(
    beginNativeTwitchDeviceAuthorization(
      saved.connectionId,
      "user",
      session.wait,
    ),
  ).rejects.toThrow("permissions");
  expect(
    session.fetcher.mock.calls.some(([url]) => String(url).endsWith("/revoke")),
  ).toBe(true);
  expect(
    loadNativeConnectorRecord(saved.connectionId)?.privateState.grants,
  ).toEqual({});
});
it("rejects a Helix user that does not match the token's validated user", async () => {
  backend();
  const session = runtime();
  const saved = await configured();
  session.fetcher.mockResolvedValueOnce(Response.json(challenge));
  session.fetcher.mockResolvedValueOnce(Response.json(token));
  session.fetcher.mockResolvedValueOnce(
    Response.json({
      client_id: clientId,
      user_id: "12345",
      login: "engineer",
      scopes: [],
      expires_in: 14000,
    }),
  );
  session.fetcher.mockResolvedValueOnce(
    Response.json({
      data: [{ id: "OTHER", login: "other", display_name: "Other" }],
    }),
  );
  await expect(
    beginNativeTwitchDeviceAuthorization(
      saved.connectionId,
      "user",
      session.wait,
    ),
  ).rejects.toThrow("valid");
  expect(readNativeConnector(saved.connectionId)?.status).toBe("configuration");
});
it("compensates a token-bearing non-success response instead of dropping an issued credential", async () => {
  backend();
  const session = runtime();
  const saved = await configured();
  session.fetcher.mockResolvedValueOnce(Response.json(challenge));
  session.fetcher.mockResolvedValueOnce(Response.json(token, { status: 400 }));
  await expect(
    beginNativeTwitchDeviceAuthorization(
      saved.connectionId,
      "user",
      session.wait,
    ),
  ).rejects.toThrow("valid");
  expect(
    session.fetcher.mock.calls.some(([url]) => String(url).endsWith("/revoke")),
  ).toBe(true);
  expect(readNativeConnector(saved.connectionId)?.status).toBe("configuration");
});
it("ends polling after provider rejection and clears the unused device code", async () => {
  backend();
  const session = runtime();
  const saved = await configured();
  session.fetcher.mockResolvedValueOnce(Response.json(challenge));
  session.fetcher.mockResolvedValueOnce(
    Response.json({ error: "access_denied" }, { status: 400 }),
  );
  await expect(
    beginNativeTwitchDeviceAuthorization(
      saved.connectionId,
      "user",
      session.wait,
    ),
  ).rejects.toThrow("declined");
  expect(session.fetcher).toHaveBeenCalledTimes(2);
  expect(
    loadNativeConnectorRecord(saved.connectionId)?.privateState.pending,
  ).toEqual({});
});
it("keeps polling finite even if the wall clock moves backwards", async () => {
  backend();
  const session = runtime();
  const saved = await configured();
  session.fetcher.mockResolvedValueOnce(
    Response.json({ ...challenge, expires_in: 8 }),
  );
  session.fetcher.mockResolvedValueOnce(
    Response.json({ message: "authorization_pending" }, { status: 400 }),
  );
  session.fetcher.mockResolvedValueOnce(
    Response.json({ message: "authorization_pending" }, { status: 400 }),
  );
  await expect(
    beginNativeTwitchDeviceAuthorization(
      saved.connectionId,
      "user",
      async (delay) => {
        session.advance(-60_000);
        expect(delay).toBeLessThanOrEqual(5000);
      },
    ),
  ).rejects.toThrow("expired");
  expect(session.fetcher).toHaveBeenCalledTimes(3);
});
