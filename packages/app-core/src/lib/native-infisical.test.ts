import { expect, it } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import { installNativeApiTests } from "./native-api.test-support.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";
import { infisicalKeyFlows } from "./native-infisical.js";
import {
  ACCESS,
  CLIENT_ID,
  CLIENT_SECRET,
  PROJECT,
  draft,
  login,
  names,
  routes,
} from "./native-infisical.test-support.js";

installNativeApiTests();

it("proves a machine identity by Universal Auth's login at Infisical's own address, and keeps neither the token nor the secret on the record", async () => {
  const fixture = routes(login);
  const saved = await infisicalKeyFlows.configure(draft(), fixture.transport);
  expect(saved).toMatchObject({
    status: "connected",
    identity: { kind: "machine-identity", assurance: "credential-valid" },
  });
  const [call] = fixture.calls;
  expect(call?.url).toBe(
    "https://app.infisical.com/api/v1/auth/universal-auth/login",
  );
  expect(call?.init).toMatchObject({
    method: "POST",
    mode: "cors",
    credentials: "omit",
    redirect: "error",
  });
  expect(JSON.parse(String(call?.init?.body))).toEqual({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
  });
  expect(new Headers(call?.init?.headers).get("authorization")).toBeNull();
  for (const text of [
    JSON.stringify(saved),
    JSON.stringify(readDeviceRows()),
  ]) {
    expect(text).not.toContain(CLIENT_SECRET);
    expect(text).not.toContain(ACCESS);
  }
});

it("logs in at the EU region's address when that is the region chosen", async () => {
  const fixture = routes(login);
  await infisicalKeyFlows.configure(draft("eu"), fixture.transport);
  expect(fixture.calls[0]?.url).toBe(
    "https://eu.infisical.com/api/v1/auth/universal-auth/login",
  );
});

it("refuses a form that asks for anything else, or a client ID or secret that is not one, before any request", async () => {
  const changes: Partial<NativeApiConfigureInput>[] = [
    { parameters: { site: "us", endpoint: "https://evil.test" } },
    { parameters: { site: "https://evil.test" } },
    { credentials: { client_id: "not-a-uuid", client_secret: CLIENT_SECRET } },
    { credentials: { client_id: CLIENT_ID, client_secret: "short" } },
    {
      credentials: { client_id: CLIENT_ID, client_secret: "has space in it 1" },
    },
    {
      credentials: {
        client_id: CLIENT_ID,
        client_secret: CLIENT_SECRET,
        extra: "x",
      },
    },
    { requestedScopes: { app: ["x"] } },
  ];
  for (const change of changes) {
    const fixture = routes(login);
    await expect(
      infisicalKeyFlows.configure({ ...draft(), ...change }, fixture.transport),
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
  "classifies Infisical's %s as a failure of the login, never echoing what it said, and saves nothing",
  async (status, words) => {
    const message = "Invalid credentials for machine@private.example";
    const fixture = routes({
      ...login,
      body: { message, error: "UnauthorizedError" },
      status,
    });
    const failure = await infisicalKeyFlows
      .configure(draft(), fixture.transport)
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

it("does not take a login answer that is not an access token", async () => {
  for (const body of [
    {},
    { accessToken: "short" },
    { accessToken: "has a space in it that is long enough" },
    { accessToken: 7 },
    [],
  ]) {
    await expect(
      infisicalKeyFlows.configure(
        draft(),
        routes({ ...login, body }).transport,
      ),
    ).rejects.toThrow();
  }
  expect(readDeviceRows()).toEqual([]);
});

it("lists names and reads a value once, with the token from a fresh login each time, never keeping either", async () => {
  const saved = await infisicalKeyFlows.configure(
    draft(),
    routes(login).transport,
  );
  const listing = routes(login, names);
  const result = await infisicalKeyFlows.invoke(
    saved.connectionId,
    "provider.names.read",
    { project: PROJECT, environment: "", path: "" },
    listing.transport,
  );
  expect(result.items.map((item) => item.id)).toEqual([
    "DATABASE_URL",
    "API_TOKEN",
  ]);
  // Names only: the values Infisical sent are not in what comes back.
  expect(JSON.stringify(result)).not.toContain("postgres://hidden");
  const [, read] = listing.calls;
  expect(read?.url).toBe(
    `https://app.infisical.com/api/v3/secrets/raw?workspaceId=${PROJECT}&environment=prod&secretPath=%2F`,
  );
  expect(new Headers(read?.init?.headers).get("authorization")).toBe(
    `Bearer ${ACCESS}`,
  );

  const value = routes(login, {
    match: /\/api\/v3\/secrets\/raw\/DATABASE_URL\?/,
    body: {
      secret: { secretKey: "DATABASE_URL", secretValue: "s3cret-value" },
    },
  });
  const one = await infisicalKeyFlows.invoke(
    saved.connectionId,
    "provider.secret.read",
    {
      project: PROJECT,
      environment: "dev",
      path: "/app/db",
      name: "DATABASE_URL",
    },
    value.transport,
  );
  expect(value.calls[1]?.url).toBe(
    `https://app.infisical.com/api/v3/secrets/raw/DATABASE_URL?workspaceId=${PROJECT}&environment=dev&secretPath=%2Fapp%2Fdb`,
  );
  expect(one.items[0]?.secretValue).toBe("s3cret-value");
  for (const text of [
    JSON.stringify(loadNativeConnectorRecord(saved.connectionId)),
    JSON.stringify(readNativeConnector(saved.connectionId)),
  ])
    expect(text).not.toContain("s3cret-value");
});

it("refuses a read that names a project, environment, folder or secret that is not one, before any request", async () => {
  const saved = await infisicalKeyFlows.configure(
    draft(),
    routes(login).transport,
  );
  const folder = { project: PROJECT, environment: "prod", path: "/" };
  const bad = [
    { ...folder, project: "" },
    { ...folder, project: "has space" },
    { ...folder, environment: "a/b" },
    { ...folder, path: "no-leading-slash" },
    { ...folder, path: "/a/../b" },
    { ...folder, path: "/a//b" },
  ];
  for (const input of bad) {
    const fixture = routes(login, names);
    await expect(
      infisicalKeyFlows.invoke(
        saved.connectionId,
        "provider.names.read",
        input,
        fixture.transport,
      ),
    ).rejects.toThrow();
    expect(fixture.fetch).not.toHaveBeenCalled();
  }
  for (const name of ["", "../x", "a/b", "has space", "x".repeat(256)]) {
    const fixture = routes(login);
    await expect(
      infisicalKeyFlows.invoke(
        saved.connectionId,
        "provider.secret.read",
        { ...folder, name },
        fixture.transport,
      ),
    ).rejects.toThrow();
    expect(fixture.fetch).not.toHaveBeenCalled();
  }
  // A value that is not text has no honest value to show.
  await expect(
    infisicalKeyFlows.invoke(
      saved.connectionId,
      "provider.secret.read",
      { ...folder, name: "X" },
      routes(login, {
        match: /raw\/X\?/,
        body: { secret: { secretKey: "X", secretValue: 7 } },
      }).transport,
    ),
  ).rejects.toThrow();
});
