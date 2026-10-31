import { afterEach, expect, it } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import { loadNativeConnectorRecord } from "./native-connector-store.js";
import {
  beginNativeOAuthClient,
  configureNativeOAuthClient,
  nativeOAuthClientTarget,
  readNativeOAuthClientSecret,
} from "./native-oauth-client-config.js";
import { exchangeNativeOAuthClient } from "./native-oauth-client-exchange.js";
import {
  CLIENT_SECRET,
  nativeOAuthClientFixture,
} from "./native-oauth-client.test-support.js";
import { verifyNativeOAuthResource } from "./native-oauth-resource.js";

const closes: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
const emptyOptionalControls = {
  token_relay_url: "",
  resource_protocol: "",
  mcp_endpoint: "",
  mcp_transport: "",
  mcp_post_endpoint: "",
};
async function authenticate(
  f: Awaited<ReturnType<typeof nativeOAuthClientFixture>>,
  connectionId: string,
) {
  const authorization = new URL(
    await beginNativeOAuthClient(connectionId, f.owner),
  );
  f.state.challenge = authorization.searchParams.get("code_challenge") ?? "";
  await exchangeNativeOAuthClient(
    new URLSearchParams({
      native_state: authorization.searchParams.get("state") ?? "",
      native_code: "one-use-code",
    }).toString(),
    f.owner,
  );
  return verifyNativeOAuthResource(connectionId, f.owner);
}
it.each(["none", "client_secret_basic", "client_secret_post"] as const)(
  "connects the actual %s resource without a relay and preserves saved access across blank optional form controls",
  async (method) => {
    const f = await nativeOAuthClientFixture(method);
    closes.push(f.close);
    const input = {
      ...f.input,
      parameters: { ...f.input.parameters, ...emptyOptionalControls },
    };
    const saved = await configureNativeOAuthClient(input, f.owner);
    const { client_id, ...expectedParameters } = f.input.parameters;
    expect(saved.configuration.clientId).toBe(client_id);
    expect(saved.configuration.parameters).toEqual({
      ...expectedParameters,
      redirect_uri: f.owner.redirectUri,
    });
    expect(() =>
      nativeOAuthClientTarget({
        ...saved.configuration,
        parameters: { ...saved.configuration.parameters, token_relay_url: "" },
      }),
    ).toThrow();
    const connected = await authenticate(f, saved.connectionId);
    expect(connected.view.status).toBe("connected");
    expect(connected.body).toEqual({
      projects: [{ id: "project-42", name: "Actual configured project" }],
    });
    expect(readNativeOAuthClientSecret(saved.connectionId, f.owner)).toBe(
      method === "none" ? undefined : CLIENT_SECRET,
    );
    const before = loadNativeConnectorRecord(saved.connectionId);
    const renamedInput = {
      ...input,
      connectionId: saved.connectionId,
      revision: connected.view.revision,
      displayName: "Saved native resource",
      credentials: { client_secret: "" },
    };
    const renamed = await configureNativeOAuthClient(renamedInput, f.owner);
    expect(renamed.configuration.displayName).toBe("Saved native resource");
    expect(renamed.status).toBe("connected");
    const after = loadNativeConnectorRecord(saved.connectionId);
    expect(after?.privateState).toEqual(before?.privateState);
    expect(after?.runtime).toEqual(before?.runtime);
    expect(renamed.fingerprint).toBe(saved.fingerprint);
    const unchanged = await configureNativeOAuthClient(
      { ...renamedInput, revision: renamed.revision },
      f.owner,
    );
    expect(unchanged.revision).toBe(renamed.revision);
    expect(f.requests.map((request) => request.path)).toEqual([
      "/token",
      "/resource",
    ]);
    expect(f.requests[1]?.authorization).toBe("Bearer issued-access-1");
    expect(JSON.stringify(readDeviceRows())).not.toContain(CLIENT_SECRET);
  },
);
it("stays connected after offline consent is proven by a refresh token", async () => {
  const f = await nativeOAuthClientFixture("client_secret_post");
  closes.push(f.close);
  f.state.resourceParameter = "omit";
  const input = {
    ...f.input,
    parameters: { ...f.input.parameters, resource_parameter: "omit" as const },
    requestedScopes: { user: ["offline_access", "read:items"] },
  };
  const saved = await configureNativeOAuthClient(input, f.owner);
  const connected = await authenticate(f, saved.connectionId);
  expect(connected.view.status).toBe("connected");
  expect(connected.view.grants[0]?.grantedScopes).toEqual(["read:items"]);
});

it.each([
  ["token_relay_url", "http://relay.example/token"],
  ["token_relay_url", "not-a-url"],
  ["token_endpoint", ""],
  ["token_auth_method", ""],
  ["unknown_parameter", ""],
])(
  "rejects invalid or unknown form parameter %s=%s before custody or egress",
  async (key, value) => {
    const f = await nativeOAuthClientFixture();
    closes.push(f.close);
    await expect(
      configureNativeOAuthClient(
        {
          ...f.input,
          parameters: {
            ...f.input.parameters,
            ...emptyOptionalControls,
            [key]: value,
          },
        },
        f.owner,
      ),
    ).rejects.toThrow();
    expect(readDeviceRows()).toHaveLength(0);
    expect(f.requests).toHaveLength(0);
  },
);
it("retains an explicitly configured HTTPS relay instead of treating it as absent", async () => {
  const f = await nativeOAuthClientFixture();
  closes.push(f.close);
  const relay = "https://operator-relay.example/oauth/token?provider=custom";
  const saved = await configureNativeOAuthClient(
    {
      ...f.input,
      parameters: { ...f.input.parameters, token_relay_url: relay },
    },
    f.owner,
  );
  expect(nativeOAuthClientTarget(saved.configuration).token_relay_url).toBe(
    relay,
  );
  expect(f.requests).toHaveLength(0);
});
