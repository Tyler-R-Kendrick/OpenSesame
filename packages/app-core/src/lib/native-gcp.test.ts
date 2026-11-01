import { expect, it } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import { installNativeApiTests } from "./native-api.test-support.js";
import { bytesToBase64 } from "./native-base64.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";
import { gcpKeyFlows } from "./native-gcp.js";
import {
  EMAIL,
  b64url,
  draft,
  gcpKeyFile,
  gcpPublicKey,
  installGcpKey,
  list,
  routes,
  token,
} from "./native-gcp.test-support.js";
import { asBufferSource } from "@opensesame/os-domain";

installNativeApiTests();
installGcpKey();

it("signs a JWT with the key in this page, exchanges it at Google's own token address, then lists secrets", async () => {
  const fixture = routes(token, list);
  const saved = await gcpKeyFlows.configure(draft(), fixture.transport);
  expect(saved).toMatchObject({
    status: "connected",
    identity: {
      id: EMAIL,
      kind: "service-account",
      assurance: "credential-valid",
    },
  });
  const [exchange, listing] = fixture.calls;
  // The address is Google's, whatever the key file says token_uri is.
  expect(exchange?.url).toBe("https://oauth2.googleapis.com/token");
  expect(exchange?.init).toMatchObject({
    method: "POST",
    mode: "cors",
    credentials: "omit",
    redirect: "error",
  });
  const form = new URLSearchParams(String(exchange?.init?.body));
  expect(form.get("grant_type")).toBe(
    "urn:ietf:params:oauth:grant-type:jwt-bearer",
  );
  const [header, claims, signature] = (form.get("assertion") ?? "").split(".");
  expect(JSON.parse(new TextDecoder().decode(b64url(header ?? "")))).toEqual({
    alg: "RS256",
    typ: "JWT",
  });
  const body = JSON.parse(new TextDecoder().decode(b64url(claims ?? "")));
  expect(body).toMatchObject({
    iss: EMAIL,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: "https://oauth2.googleapis.com/token",
  });
  expect(body.exp - body.iat).toBe(3600);
  // The signature is the key's, checked with the public half independently.
  expect(
    await crypto.subtle.verify(
      "RSASSA-PKCS1-v1_5",
      gcpPublicKey(),
      asBufferSource(b64url(signature ?? "")),
      new TextEncoder().encode(`${header}.${claims}`),
    ),
  ).toBe(true);
  expect(listing?.url).toBe(
    "https://secretmanager.googleapis.com/v1/projects/my-project-123/secrets?pageSize=20",
  );
  expect(new Headers(listing?.init?.headers).get("authorization")).toBe(
    "Bearer ya29.test-access-token-0123456789",
  );
  // The key is sealed with the connection; neither it nor a token is on the record.
  expect(JSON.stringify(readDeviceRows())).not.toContain("BEGIN PRIVATE KEY");
  expect(JSON.stringify(saved)).not.toContain("ya29.test-access-token");
  expect(JSON.stringify(saved)).not.toContain("BEGIN PRIVATE KEY");
});

it("takes the key's own project when none is typed, and refuses a key file or project that is not one, before any request", async () => {
  const own = routes(token, {
    ...list,
    match: /projects\/my-project-123\/secrets\?/,
  });
  const saved = await gcpKeyFlows.configure(
    { ...draft(), parameters: {} },
    own.transport,
  );
  expect(saved.targets[0]?.id).toBe("my-project-123");
  const changes: Partial<NativeApiConfigureInput>[] = [
    { credentials: { service_account_json: "not json" } },
    {
      credentials: {
        service_account_json: JSON.stringify({ type: "authorized_user" }),
      },
    },
    {
      credentials: {
        service_account_json: JSON.stringify({
          ...JSON.parse(gcpKeyFile()),
          client_email: "x@evil.example",
        }),
      },
    },
    {
      credentials: {
        service_account_json: JSON.stringify({
          ...JSON.parse(gcpKeyFile()),
          private_key:
            "-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----",
        }),
      },
    },
    { parameters: { project: "Bad Project!" } },
    {
      parameters: { project: "my-project-123", endpoint: "https://evil.test" },
    },
    { requestedScopes: { app: ["x"] } },
    { credentials: { service_account_json: gcpKeyFile(), extra: "x" } },
  ];
  for (const change of changes) {
    const fixture = routes(token, list);
    await expect(
      gcpKeyFlows.configure({ ...draft(), ...change }, fixture.transport),
    ).rejects.toThrow();
    expect(fixture.fetch).not.toHaveBeenCalled();
  }
});

it.each([
  [400, "invalid_grant", "refused"],
  [401, "x", "refused"],
  [403, "x", "permissions"],
  [429, "x", "rate limit"],
  [500, "x", "expected response"],
])(
  "classifies Google's %s at the token address as a refusal of the %s, never echoing it, and saves nothing",
  async (status, error, words) => {
    const message = "Invalid JWT Signature for secret-account@private.example";
    const fixture = routes({
      match: /oauth2/,
      body: { error, error_description: message },
      status,
    });
    const failure = await gcpKeyFlows
      .configure(draft(), fixture.transport)
      .then(
        () => null,
        (e) => e,
      );
    if (!(failure instanceof Error))
      throw new Error("A refused key must throw");
    expect(failure.message.toLowerCase()).toContain(words);
    expect(failure.message).not.toContain(message);
    expect(readDeviceRows()).toEqual([]);
  },
);

it("does not read a token reply or a secret listing that is not one", async () => {
  for (const bad of [
    { match: /oauth2/, body: { access_token: "short" } },
    { match: /oauth2/, body: [] },
    {
      match: /oauth2/,
      body: { access_token: "has a space in it that is long enough" },
    },
  ]) {
    await expect(
      gcpKeyFlows.configure(draft(), routes(bad, list).transport),
    ).rejects.toThrow();
  }
  for (const body of [
    { secrets: "x" },
    { secrets: [{ name: "projects/1/secrets/has space" }] },
    { secrets: [{ name: 7 }] },
    [],
  ]) {
    await expect(
      gcpKeyFlows.configure(
        draft(),
        routes(token, { ...list, body }).transport,
      ),
    ).rejects.toThrow();
  }
  expect(readDeviceRows()).toEqual([]);
});

it("verifies a project that holds no secrets yet", async () => {
  const empty = routes(token, { ...list, body: {} });
  await expect(
    gcpKeyFlows.configure(draft(), empty.transport),
  ).resolves.toMatchObject({ status: "connected" });
});

it("lists names and reads a secret's latest value once, never keeping it", async () => {
  const saved = await gcpKeyFlows.configure(
    draft(),
    routes(token, list).transport,
  );
  const names = await gcpKeyFlows.invoke(
    saved.connectionId,
    "provider.names.read",
    {},
    routes(token, list).transport,
  );
  expect(names.items.map((item) => item.id)).toEqual([
    "db-password",
    "api_key",
  ]);
  const value = routes(token, {
    match: /secrets\/db-password\/versions\/latest:access$/,
    body: {
      payload: {
        data: bytesToBase64(new TextEncoder().encode("hunter2-value")),
      },
    },
  });
  const result = await gcpKeyFlows.invoke(
    saved.connectionId,
    "provider.secret.read",
    { name: "db-password" },
    value.transport,
  );
  expect(value.calls[1]?.url).toBe(
    "https://secretmanager.googleapis.com/v1/projects/my-project-123/secrets/db-password/versions/latest:access",
  );
  expect(result.items[0]?.secretValue).toBe("hunter2-value");
  expect(
    JSON.stringify(loadNativeConnectorRecord(saved.connectionId)),
  ).not.toContain("hunter2-value");
  expect(JSON.stringify(readNativeConnector(saved.connectionId))).not.toContain(
    "hunter2-value",
  );
  for (const name of ["", "../x", "a/b", "has space", "x".repeat(256)]) {
    const fixture = routes(token);
    await expect(
      gcpKeyFlows.invoke(
        saved.connectionId,
        "provider.secret.read",
        { name },
        fixture.transport,
      ),
    ).rejects.toThrow();
    expect(fixture.fetch).not.toHaveBeenCalled();
  }
  // A binary secret has no honest text to show.
  const binary = routes(token, {
    match: /latest:access$/,
    body: {
      payload: { data: bytesToBase64(new Uint8Array([0xff, 0xfe, 0xfd])) },
    },
  });
  await expect(
    gcpKeyFlows.invoke(
      saved.connectionId,
      "provider.secret.read",
      { name: "db-password" },
      binary.transport,
    ),
  ).rejects.toThrow();
});

it("re-proves on provider.read, and a refused key stops looking verified", async () => {
  const saved = await gcpKeyFlows.configure(
    draft(),
    routes(token, list).transport,
  );
  const ok = await gcpKeyFlows.invoke(
    saved.connectionId,
    "provider.read",
    {},
    routes(token, list).transport,
  );
  expect(ok.label).toBe("Google Cloud Secret Manager access verified");
  await expect(
    gcpKeyFlows.invoke(
      saved.connectionId,
      "provider.read",
      {},
      routes({ match: /oauth2/, body: { error: "invalid_grant" }, status: 400 })
        .transport,
    ),
  ).rejects.toThrow();
  expect(readNativeConnector(saved.connectionId)?.status).not.toBe("connected");
});
