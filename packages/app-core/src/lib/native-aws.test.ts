import type { BoundaryValue } from "@opensesame/os-domain";
import { expect, it, vi } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import { installNativeApiTests } from "./native-api.test-support.js";
import {
  configureNativeAws,
  invokeNativeAws,
  nativeAwsCleanup,
  verifyNativeAws,
} from "./native-aws.js";
import {
  registerNativeProviderCleanup,
  removeNativeConnectorWithCleanup,
} from "./native-connector-lifecycle.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";

installNativeApiTests();

const draft = (providerId = "aws") => ({
  providerId,
  displayName: "AWS",
  parameters: { region: "us-east-1", access_key_id: "AKIAIOSFODNN7EXAMPLE" },
  credentials: {
    secret_access_key: "private-signing-secret",
    session_token: "private-session-token",
  },
});

/** Replies are AWS JSON 1.1 bodies, with the status AWS gives. */
function answers(...replies: { body: BoundaryValue; status?: number }[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const reply = replies.shift();
    if (!reply) throw new Error("No AWS response queued");
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "Content-Type": "application/x-amz-json-1.1" },
    });
  });
  const assertCurrent = vi.fn();
  return { fetch, assertCurrent, transport: { fetch, assertCurrent } };
}
const secrets = { SecretList: [{ Name: "prod/db", ARN: "arn:x" }] };
const parameters = {
  Parameters: [{ Name: "/prod/db/url", Type: "SecureString" }],
};

it("signs a real Secrets Manager list before sealing proof, to the endpoint AWS publishes for the region", async () => {
  const fixture = answers({ body: secrets });
  const saved = await configureNativeAws(draft(), fixture.transport);
  expect(saved).toMatchObject({
    status: "connected",
    identity: {
      id: "us-east-1",
      kind: "region",
      assurance: "credential-valid",
    },
    grants: [{ permissionState: "provider-managed", grantedScopes: [] }],
  });
  const [url, init] = fixture.fetch.mock.calls[0] ?? [];
  expect(String(url)).toBe("https://secretsmanager.us-east-1.amazonaws.com/");
  expect(init).toMatchObject({
    method: "POST",
    mode: "cors",
    redirect: "error",
    credentials: "omit",
    body: '{"MaxResults":20}',
  });
  const headers = new Headers(init?.headers);
  expect(headers.get("x-amz-target")).toBe("secretsmanager.ListSecrets");
  expect(headers.get("content-type")).toBe("application/x-amz-json-1.1");
  expect(headers.get("authorization")).toMatch(
    /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/secretsmanager\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token;x-amz-target, Signature=[0-9a-f]{64}$/,
  );
  expect(headers.get("x-amz-security-token")).toBe("private-session-token");
  // Neither S3's body-hash header nor a host a browser would refuse to set.
  expect(headers.has("x-amz-content-sha256")).toBe(false);
  expect(headers.has("host")).toBe(false);
  expect(JSON.stringify(readDeviceRows())).not.toContain(
    "private-signing-secret",
  );
  expect(JSON.stringify(saved)).not.toContain("private-session-token");
});

it("verifies Parameter Store with its own service name and target", async () => {
  const fixture = answers({ body: parameters });
  const saved = await configureNativeAws(draft("aws-ps"), fixture.transport);
  expect(saved.identity?.label).toBe("AWS Parameter Store in us-east-1");
  const [url, init] = fixture.fetch.mock.calls[0] ?? [];
  expect(String(url)).toBe("https://ssm.us-east-1.amazonaws.com/");
  expect(new Headers(init?.headers).get("x-amz-target")).toBe(
    "AmazonSSM.DescribeParameters",
  );
  expect(new Headers(init?.headers).get("authorization")).toContain(
    "/us-east-1/ssm/aws4_request",
  );
});

it("accepts a GovCloud or newer-style region and refuses anything that is not one, before any request", async () => {
  const gov = answers({ body: secrets });
  await configureNativeAws(
    {
      ...draft(),
      parameters: { ...draft().parameters, region: "us-gov-west-1" },
    },
    gov.transport,
  );
  expect(String(gov.fetch.mock.calls[0]?.[0])).toBe(
    "https://secretsmanager.us-gov-west-1.amazonaws.com/",
  );
  for (const region of [
    "",
    "us-east",
    "evil.example.com/x",
    "us-east-1.attacker.test",
    "US-EAST-1",
    "us-east-1@evil",
  ]) {
    const fixture = answers({ body: secrets });
    await expect(
      configureNativeAws(
        { ...draft(), parameters: { ...draft().parameters, region } },
        fixture.transport,
      ),
    ).rejects.toThrow();
    expect(fixture.fetch).not.toHaveBeenCalled();
  }
});

it("takes no endpoint, scope or target: the address is compiled, never typed", async () => {
  for (const change of [
    { parameters: { ...draft().parameters, endpoint: "https://evil.test" } },
    { requestedScopes: { app: ["x"] } },
    { targetIds: { region: "us-east-1" } },
    { credentials: { ...draft().credentials, api_key: "x" } },
    { providerId: "s3" },
  ]) {
    const fixture = answers({ body: secrets });
    await expect(
      configureNativeAws({ ...draft(), ...change }, fixture.transport),
    ).rejects.toThrow();
    expect(fixture.fetch).not.toHaveBeenCalled();
  }
});

it.each([
  [400, "UnrecognizedClientException", "refused"],
  [400, "InvalidSignatureException", "refused"],
  [400, "ExpiredTokenException", "refused"],
  [400, "com.amazon.coral.service#UnrecognizedClientException", "refused"],
  [400, "AccessDeniedException", "permissions"],
  [400, "ThrottlingException", "rate limit"],
  [429, "TooManyRequestsException", "rate limit"],
  [500, "InternalFailure", "expected response"],
])(
  "classifies AWS's %s %s as a refusal of the %s, and saves nothing",
  async (status, type, words) => {
    const message =
      "secret detail AWS echoes: arn:aws:iam::123456789012:user/x";
    const fixture = answers({ body: { __type: type, message }, status });
    const failure = await configureNativeAws(draft(), fixture.transport).then(
      () => null,
      (error) => error,
    );
    if (!(failure instanceof Error))
      throw new Error("A refused key must throw");
    expect(failure.message.toLowerCase()).toContain(words);
    // What AWS says back is never what this page says.
    expect(failure.message).not.toContain(message);
    expect(readDeviceRows()).toEqual([]);
  },
);

it.each([
  { SecretList: "nope" },
  { SecretList: [{ Name: "has a space" }] },
  { SecretList: [{ Name: 7 }] },
  { SecretList: Array.from({ length: 101 }, (_, i) => ({ Name: `s${i}` })) },
  [],
])("refuses a list that is not what AWS returns", async (body) => {
  await expect(
    configureNativeAws(draft(), answers({ body }).transport),
  ).rejects.toThrow("expected response");
  expect(readDeviceRows()).toEqual([]);
});

it("refuses a body larger than it asked for and one that is not JSON", async () => {
  const big = vi.fn<typeof globalThis.fetch>(
    async () =>
      new Response(`{"SecretList":[],"x":"${"x".repeat(256 * 1024)}"}`),
  );
  await expect(
    configureNativeAws(draft(), { fetch: big, assertCurrent: vi.fn() }),
  ).rejects.toThrow("expected response");
  const html = vi.fn<typeof globalThis.fetch>(
    async () => new Response("<html>Sign in</html>"),
  );
  await expect(
    configureNativeAws(draft(), { fetch: html, assertCurrent: vi.fn() }),
  ).rejects.toThrow("expected response");
});

it("lists names on request and reads one value once, never keeping it", async () => {
  const fixture = answers(
    { body: secrets },
    { body: secrets },
    { body: { SecretString: "hunter2-value" } },
  );
  const saved = await configureNativeAws(draft(), fixture.transport);
  const names = await invokeNativeAws(
    saved.connectionId,
    "provider.names.read",
    {},
    fixture.transport,
  );
  expect(names.items).toEqual([{ id: "prod/db", label: "prod/db" }]);
  const read = await invokeNativeAws(
    saved.connectionId,
    "provider.secret.read",
    { name: "prod/db" },
    fixture.transport,
  );
  expect(read.items).toEqual([
    { id: "prod/db", label: "prod/db", secretValue: "hunter2-value" },
  ]);
  const [, init] = fixture.fetch.mock.calls[2] ?? [];
  expect(new Headers(init?.headers).get("x-amz-target")).toBe(
    "secretsmanager.GetSecretValue",
  );
  expect(init?.body).toBe('{"SecretId":"prod/db"}');
  expect(JSON.stringify(readDeviceRows())).not.toContain("hunter2-value");
  expect(
    JSON.stringify(loadNativeConnectorRecord(saved.connectionId)),
  ).not.toContain("hunter2-value");
});

it("reads a Parameter Store value with decryption and refuses what is not text", async () => {
  const fixture = answers(
    { body: parameters },
    { body: { Parameter: { Value: "postgres://x" } } },
    { body: { Parameter: { Value: 42 } } },
  );
  const saved = await configureNativeAws(draft("aws-ps"), fixture.transport);
  const read = await invokeNativeAws(
    saved.connectionId,
    "provider.secret.read",
    { name: "/prod/db/url" },
    fixture.transport,
  );
  expect(read.items[0]?.secretValue).toBe("postgres://x");
  expect(fixture.fetch.mock.calls[1]?.[1]?.body).toBe(
    '{"Name":"/prod/db/url","WithDecryption":true}',
  );
  await expect(
    invokeNativeAws(
      saved.connectionId,
      "provider.secret.read",
      { name: "/prod/db/url" },
      fixture.transport,
    ),
  ).rejects.toThrow("expected response");
});

it("refuses an operation or input it does not offer, and a name AWS would not allow", async () => {
  const fixture = answers({ body: secrets });
  const saved = await configureNativeAws(draft(), fixture.transport);
  for (const [operation, input] of [
    ["provider.delete", {}],
    ["provider.read", { extra: "x" }],
    ["provider.secret.read", {}],
    ["provider.secret.read", { name: "prod/db", extra: "x" }],
  ] as const)
    await expect(
      invokeNativeAws(
        saved.connectionId,
        operation,
        { ...input },
        fixture.transport,
      ),
    ).rejects.toThrow("supported AWS operation");
  await expect(
    invokeNativeAws(
      saved.connectionId,
      "provider.secret.read",
      { name: "has a space" },
      fixture.transport,
    ),
  ).rejects.toThrow("valid name");
  expect(fixture.fetch).toHaveBeenCalledOnce();
});

it("invalidates a verified connection when AWS later refuses the key", async () => {
  const fixture = answers(
    { body: secrets },
    { body: { __type: "AccessDeniedException", message: "no" }, status: 400 },
  );
  const saved = await configureNativeAws(draft(), fixture.transport);
  await expect(
    verifyNativeAws(saved.connectionId, fixture.transport),
  ).rejects.toThrow("permissions");
  expect(readNativeConnector(saved.connectionId)?.status).not.toBe("connected");
  // And a stale write cannot revive it.
  await expect(
    configureNativeAws(
      {
        ...draft(),
        connectionId: saved.connectionId,
        revision: saved.revision,
      },
      fixture.transport,
    ),
  ).rejects.toThrow("changed");
});

it("will not read a value through a connection that is not verified", async () => {
  const fixture = answers(
    { body: secrets },
    { body: { __type: "AccessDeniedException" }, status: 400 },
  );
  const saved = await configureNativeAws(draft(), fixture.transport);
  await expect(
    verifyNativeAws(saved.connectionId, fixture.transport),
  ).rejects.toThrow();
  await expect(
    invokeNativeAws(
      saved.connectionId,
      "provider.secret.read",
      { name: "prod/db" },
      fixture.transport,
    ),
  ).rejects.toThrow("Verify AWS access");
  expect(fixture.fetch).toHaveBeenCalledTimes(2);
});

it("replaces temporary credentials with a permanent key without reusing the old session token", async () => {
  const fixture = answers({ body: secrets }, { body: secrets });
  const saved = await configureNativeAws(draft(), fixture.transport);
  await configureNativeAws(
    {
      ...draft(),
      connectionId: saved.connectionId,
      revision: saved.revision,
      credentials: { secret_access_key: "replacement-permanent-secret" },
    },
    fixture.transport,
  );
  expect(
    new Headers(fixture.fetch.mock.calls[1]?.[1]?.headers).has(
      "x-amz-security-token",
    ),
  ).toBe(false);
});

it("forgets the key locally on removal and revokes nothing at AWS", async () => {
  const fixture = answers({ body: secrets });
  const saved = await configureNativeAws(draft(), fixture.transport);
  const release = registerNativeProviderCleanup("aws", nativeAwsCleanup);
  try {
    await removeNativeConnectorWithCleanup(saved.connectionId);
  } finally {
    release();
  }
  expect(loadNativeConnectorRecord(saved.connectionId)).toBeNull();
  expect(fixture.fetch).toHaveBeenCalledOnce();
});

it("rejects a transport disposed before a verified result can be persisted", async () => {
  const fixture = answers({ body: secrets });
  let calls = 0;
  fixture.assertCurrent.mockImplementation(() => {
    if (++calls > 2) throw new Error("Lease disposed");
  });
  await expect(
    configureNativeAws(draft(), fixture.transport),
  ).rejects.toThrow();
  expect(readDeviceRows()).toEqual([]);
});
