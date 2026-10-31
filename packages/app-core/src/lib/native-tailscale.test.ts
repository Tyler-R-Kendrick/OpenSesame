import { beforeEach, expect, it } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import { fakeTailscaleAuthKeyPublicPrefix } from "./fake-tailscale-key.js";
import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import { installNativeApiTests } from "./native-api.test-support.js";
import { loadNativeConnectorRecord } from "./native-connector-store.js";
import { tailscaleKeyFlows } from "./native-tailscale.js";
import {
  type NativeTailscaleFixtures,
  createNativeTailscaleFixtures,
  devices,
  routes,
} from "./native-tailscale.test-support.js";

installNativeApiTests();

let fx: NativeTailscaleFixtures;

beforeEach(() => {
  fx = createNativeTailscaleFixtures();
});

it("proves an API access token by reading the tailnet's devices at Tailscale's own address, and keeps it only sealed", async () => {
  const fixture = routes(devices);
  const saved = await tailscaleKeyFlows.configure(
    fx.token(),
    fixture.transport,
  );
  expect(saved).toMatchObject({
    status: "connected",
    identity: { kind: "tailnet" },
  });
  const [call] = fixture.calls;
  expect(call?.url).toBe(
    "https://api.tailscale.com/api/v2/tailnet/-/devices?fields=default",
  );
  expect(call?.init).toMatchObject({
    method: "GET",
    mode: "cors",
    credentials: "omit",
    redirect: "error",
  });
  expect(new Headers(call?.init?.headers).get("authorization")).toBe(
    `Bearer ${fx.apiToken}`,
  );
  for (const text of [JSON.stringify(saved), JSON.stringify(readDeviceRows())])
    expect(text).not.toContain(fx.apiToken);
});

it("exchanges an OAuth client's ID and secret for a token used once, never keeping the token", async () => {
  const fixture = routes(fx.exchange, devices);
  const saved = await tailscaleKeyFlows.configure(
    fx.oauth(),
    fixture.transport,
  );
  const [mint, read] = fixture.calls;
  expect(mint?.url).toBe("https://api.tailscale.com/api/v2/oauth/token");
  expect(String(mint?.init?.body)).toBe(
    new URLSearchParams({
      grant_type: "client_credentials",
      client_id: fx.clientId,
      client_secret: fx.clientSecret,
    }).toString(),
  );
  expect(new Headers(read?.init?.headers).get("authorization")).toBe(
    `Bearer ${fx.accessToken}`,
  );
  for (const text of [
    JSON.stringify(saved),
    JSON.stringify(readDeviceRows()),
    JSON.stringify(
      loadNativeConnectorRecord(saved.connectionId)?.configuration,
    ),
  ]) {
    expect(text).not.toContain(fx.accessToken);
    expect(text).not.toContain(fx.clientSecret);
  }
});

it("refuses a form with no credential, two kinds, a malformed one or a stray field, before any request", async () => {
  const both = {
    ...fx.token(),
    credentials: {
      api_token: fx.apiToken,
      client_id: fx.clientId,
      client_secret: fx.clientSecret,
    },
  };
  const changes: NativeApiConfigureInput[] = [
    { ...fx.token(), credentials: {} },
    both,
    { ...fx.token(), credentials: { api_token: "not-a-key" } },
    { ...fx.oauth(), credentials: { client_id: fx.clientId } },
    {
      ...fx.oauth(),
      credentials: { client_id: "no spaces!", client_secret: fx.clientSecret },
    },
    { ...fx.token(), parameters: { tailnet: "has space" } },
    {
      ...fx.token(),
      parameters: { tailnet: "-", endpoint: "https://evil.test" },
    },
    { ...fx.token(), credentials: { api_token: fx.apiToken, extra: "x" } },
    { ...fx.token(), requestedScopes: { app: ["x"] } },
  ];
  for (const change of changes) {
    const fixture = routes(devices);
    await expect(
      tailscaleKeyFlows.configure(change, fixture.transport),
    ).rejects.toThrow();
    expect(fixture.fetch).not.toHaveBeenCalled();
  }
  expect(readDeviceRows()).toEqual([]);
});

it.each([
  [401, "refused"],
  [403, "permissions"],
  [429, "rate limit"],
  [500, "expected response"],
])(
  "classifies Tailscale's %s without repeating what it said, and saves nothing",
  async (status, words) => {
    const message = fx.leakMessage;
    const failure = await tailscaleKeyFlows
      .configure(
        fx.token(),
        routes({ ...devices, body: { message }, status }).transport,
      )
      .then(
        () => null,
        (error) => error,
      );
    if (!(failure instanceof Error)) throw new Error("A refusal must throw");
    expect(failure.message.toLowerCase()).toContain(words);
    expect(failure.message).not.toContain(message);
    expect(readDeviceRows()).toEqual([]);
  },
);

it("lists devices with their addresses and whether they wait for approval", async () => {
  const saved = await tailscaleKeyFlows.configure(
    fx.token(),
    routes(devices).transport,
  );
  const result = await tailscaleKeyFlows.invoke(
    saved.connectionId,
    "provider.devices.read",
    {},
    routes(devices).transport,
  );
  expect(result.items).toEqual([
    { id: "12345", label: "laptop · 100.64.0.1" },
    { id: "n6789", label: "phone · waiting for approval" },
  ]);
});

it("approves and renames a device through the documented routes, and refuses a bad id or name before any request", async () => {
  const saved = await tailscaleKeyFlows.configure(
    fx.token(),
    routes(devices).transport,
  );
  const act = routes(
    { match: /\/device\/12345\/authorized$/, method: "POST" },
    { match: /\/device\/12345\/name$/, method: "POST" },
  );
  await tailscaleKeyFlows.invoke(
    saved.connectionId,
    "provider.device.authorize",
    { device: "12345" },
    act.transport,
  );
  await tailscaleKeyFlows.invoke(
    saved.connectionId,
    "provider.device.rename",
    { device: "12345", name: "work-laptop" },
    act.transport,
  );
  expect(JSON.parse(String(act.calls[0]?.init?.body))).toEqual({
    authorized: true,
  });
  expect(JSON.parse(String(act.calls[1]?.init?.body))).toEqual({
    name: "work-laptop",
  });
  for (const input of [
    { device: "../x", name: "a" },
    { device: "12345", name: "has space" },
    { device: "12345", name: "-bad" },
  ]) {
    const fixture = routes();
    await expect(
      tailscaleKeyFlows.invoke(
        saved.connectionId,
        "provider.device.rename",
        input,
        fixture.transport,
      ),
    ).rejects.toThrow();
    expect(fixture.fetch).not.toHaveBeenCalled();
  }
});

it("creates an auth key shown once, from the capabilities asked for, and never keeps it", async () => {
  const saved = await tailscaleKeyFlows.configure(
    fx.token(),
    routes(devices).transport,
  );
  const made = routes({
    match: /\/tailnet\/-\/keys$/,
    method: "POST",
    body: { id: "kAUTH1", key: fx.authKey },
  });
  const result = await tailscaleKeyFlows.invoke(
    saved.connectionId,
    "provider.key.create",
    {
      tags: "tag:server, tag:ci",
      reusable: "yes",
      ephemeral: "no",
      expiry_days: "7",
    },
    made.transport,
  );
  expect(JSON.parse(String(made.calls[0]?.init?.body))).toEqual({
    capabilities: {
      devices: {
        create: {
          reusable: true,
          ephemeral: false,
          preauthorized: true,
          tags: ["tag:server", "tag:ci"],
        },
      },
    },
    expirySeconds: 7 * 86400,
  });
  expect(result.items[0]?.secretValue).toBe(fx.authKey);
  expect(
    JSON.stringify(loadNativeConnectorRecord(saved.connectionId)),
  ).not.toContain(fakeTailscaleAuthKeyPublicPrefix(fx.authKey));
  const refused = async (tags: string, days: string) => {
    const fixture = routes();
    await expect(
      tailscaleKeyFlows.invoke(
        saved.connectionId,
        "provider.key.create",
        { tags, expiry_days: days },
        fixture.transport,
      ),
    ).rejects.toThrow();
    expect(fixture.fetch).not.toHaveBeenCalled();
  };
  await refused("server", "1");
  await refused("tag:Bad", "1");
  await refused("", "0");
  await refused("", "91");
  await refused("", "1.5");
});

it("switches from an API token to an OAuth client, and back, without restoring the old kind beside the new", async () => {
  const saved = await tailscaleKeyFlows.configure(
    fx.token(),
    routes(devices).transport,
  );
  const toOAuth = await tailscaleKeyFlows.configure(
    {
      ...fx.oauth(),
      connectionId: saved.connectionId,
      revision: saved.revision,
    },
    routes(fx.exchange, devices).transport,
  );
  const record = loadNativeConnectorRecord(toOAuth.connectionId);
  expect(Object.keys(record?.privateState.credentials ?? {}).sort()).toEqual([
    "client_id",
    "client_secret",
  ]);
  const back = await tailscaleKeyFlows.configure(
    {
      ...fx.token(),
      connectionId: toOAuth.connectionId,
      revision: toOAuth.revision,
    },
    routes(devices).transport,
  );
  expect(
    Object.keys(
      loadNativeConnectorRecord(back.connectionId)?.privateState.credentials ??
        {},
    ),
  ).toEqual(["api_token"]);
});

it("keeps a saved OAuth client's ID when only its secret is replaced", async () => {
  const saved = await tailscaleKeyFlows.configure(
    fx.oauth(),
    routes(fx.exchange, devices).transport,
  );
  const next = await tailscaleKeyFlows.configure(
    {
      ...fx.oauth(),
      credentials: {
        client_secret: fx.replacementClientSecret,
      },
      connectionId: saved.connectionId,
      revision: saved.revision,
    },
    routes(fx.exchange, devices).transport,
  );
  const held = loadNativeConnectorRecord(next.connectionId)?.privateState
    .credentials;
  expect(held?.client_id).toBe(fx.clientId);
  expect(held?.client_secret).toBe(fx.replacementClientSecret);
});
