import { afterEach, beforeEach, expect, it } from "vitest";
import { vi } from "vitest";
import { browserOAuthClassification } from "./native-browser-oauth-profile.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
  updateNativeConnector,
} from "./native-connector-store.js";
import {
  nativeTwitchValidationTargets,
  validateNativeTwitchSession,
} from "./native-twitch-session-validation.js";
import {
  saveValidationFixture,
  validationAccess,
  validationBackend,
  validationReply,
  validationTransport,
} from "./native-twitch-session-validation.test-support.js";

beforeEach(validationBackend);
afterEach(() => vi.restoreAllMocks());
it("validates the exact issued token/client/user without rewriting a successful revision", async () => {
  const id = await saveValidationFixture();
  const before = loadNativeConnectorRecord(id);
  const provider = validationTransport();
  const valid = await validateNativeTwitchSession(id, provider.transport);
  expect(valid).toMatchObject({ connectionId: id, revision: before?.revision });
  expect(loadNativeConnectorRecord(id)).toEqual(before);
  expect(provider.fetcher).toHaveBeenCalledOnce();
  const [url, init] = provider.fetcher.mock.calls[0] ?? [];
  expect(url).toBe("https://id.twitch.tv/oauth2/validate");
  expect(new Headers(init?.headers).get("authorization")).toBe(
    `OAuth ${validationAccess}`,
  );
  expect(init).toMatchObject({
    method: "GET",
    credentials: "omit",
    mode: "cors",
    cache: "no-store",
    redirect: "error",
  });
});

it.each([
  { client_id: "another-client" },
  { user_id: "another-user" },
  { scopes: [] },
  { scopes: [...validationReply.scopes, "channel:manage:broadcast"] },
  { expires_in: 0 },
])(
  "invalidates mismatched provider authority without discarding cleanup credentials: %j",
  async (override) => {
    const id = await saveValidationFixture();
    const provider = validationTransport();
    provider.fetcher.mockResolvedValue(
      Response.json({ ...validationReply, ...override }),
    );
    await expect(
      validateNativeTwitchSession(id, provider.transport),
    ).resolves.toBeNull();
    expect(readNativeConnector(id)?.status).toBe("reauthorize");
    expect(loadNativeConnectorRecord(id)?.runtime.grants[0]?.needsReauth).toBe(
      true,
    );
    expect(
      loadNativeConnectorRecord(id)?.privateState.grants.user?.accessToken,
    ).toBe(validationAccess);
  },
);

it("marks 401 as needing reauthorization while retaining a revocable sealed token", async () => {
  const id = await saveValidationFixture();
  const provider = validationTransport();
  provider.fetcher.mockResolvedValue(
    Response.json({ message: "invalid access token" }, { status: 401 }),
  );
  await expect(
    validateNativeTwitchSession(id, provider.transport),
  ).resolves.toBeNull();
  expect(nativeTwitchValidationTargets()).toEqual([]);
  expect(readNativeConnector(id)?.status).toBe("reauthorize");
  expect(
    loadNativeConnectorRecord(id)?.privateState.grants.user?.accessToken,
  ).toBe(validationAccess);
});

it("does not invalidate a verified grant on transient provider failure", async () => {
  const id = await saveValidationFixture();
  const before = loadNativeConnectorRecord(id);
  const provider = validationTransport();
  provider.fetcher.mockResolvedValue(
    Response.json({ message: "temporary failure" }, { status: 503 }),
  );
  await expect(
    validateNativeTwitchSession(id, provider.transport),
  ).rejects.toMatchObject({ status: 503 });
  expect(loadNativeConnectorRecord(id)).toEqual(before);
});

it("does not contact the provider with an expired sealed grant", async () => {
  const id = await saveValidationFixture("expired-twitch", Date.now() - 1);
  const provider = validationTransport();
  expect(nativeTwitchValidationTargets()).toEqual([]);
  await expect(
    validateNativeTwitchSession(id, provider.transport),
  ).resolves.toBeNull();
  expect(provider.fetcher).not.toHaveBeenCalled();
});

it("cannot invalidate a concurrently changed connection with a late 401", async () => {
  const id = await saveValidationFixture();
  const provider = validationTransport();
  let resolve: (reply: Response) => void = () => undefined;
  provider.fetcher.mockImplementationOnce(
    () =>
      new Promise<Response>((done) => {
        resolve = done;
      }),
  );
  const validation = validateNativeTwitchSession(id, provider.transport);
  await vi.waitFor(() => expect(provider.fetcher).toHaveBeenCalledOnce());
  const record = loadNativeConnectorRecord(id);
  if (!record) throw new Error("Expected saved Twitch fixture");
  await updateNativeConnector(
    id,
    {
      revision: record.revision,
      fingerprint: record.configuration.fingerprint,
    },
    browserOAuthClassification(record.configuration),
    (current) => {
      current.configuration.displayName = "Changed in another tab";
      return current;
    },
  );
  const failure = expect(validation).rejects.toThrow("changed");
  resolve(Response.json({ message: "invalid access token" }, { status: 401 }));
  await failure;
  expect(readNativeConnector(id)?.status).toBe("connected");
  expect(loadNativeConnectorRecord(id)?.runtime.grants[0]?.needsReauth).toBe(
    false,
  );
});
