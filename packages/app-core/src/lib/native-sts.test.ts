import { expect, it, vi } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import { installNativeApiTests } from "./native-api.test-support.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";
import { isNativeStsProvider, stsKeyFlows } from "./native-sts.js";

installNativeApiTests();

const draft = () => ({
  providerId: "aws-sts",
  displayName: "AWS STS",
  parameters: { region: "us-east-1", access_key_id: "AKIAIOSFODNN7EXAMPLE" },
  credentials: {
    secret_access_key: "private-signing-secret",
    session_token: "private-session-token",
  },
});

const who = `<GetCallerIdentityResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <GetCallerIdentityResult>
    <Arn>arn:aws:iam::123456789012:user/Alice</Arn>
    <UserId>AIDACKCEVSQ6C2EXAMPLE</UserId>
    <Account>123456789012</Account>
  </GetCallerIdentityResult>
  <ResponseMetadata><RequestId>01234567-89ab-cdef-0123-456789abcdef</RequestId></ResponseMetadata>
</GetCallerIdentityResponse>`;

const assumed = `<AssumeRoleResponse xmlns="https://sts.amazonaws.com/doc/2011-06-15/">
  <AssumeRoleResult>
    <Credentials>
      <AccessKeyId>ASIAIOSFODNN7EXAMPLE</AccessKeyId>
      <SecretAccessKey>wJalrXUtnFEMI/K7MDENG/bPxRfiCYzEXAMPLEKEY</SecretAccessKey>
      <SessionToken>AQoDYXdzEPT//////////wEXAMPLEtc764bNrC9SAPBSM22wDOk4x4HIZ8j4FZTwdQWLWsKWHGBuFqwAeMicRXmxfpSPfIeoIYRqTflfKD8YUuwthAx7mSEI</SessionToken>
      <Expiration>2026-10-12T19:00:00Z</Expiration>
    </Credentials>
  </AssumeRoleResult>
</AssumeRoleResponse>`;

function answers(...replies: { body: string; status?: number }[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const reply = replies.shift();
    if (!reply) throw new Error("No STS response queued");
    return new Response(reply.body, {
      status: reply.status ?? 200,
      headers: { "Content-Type": "text/xml" },
    });
  });
  const assertCurrent = vi.fn();
  return { fetch, assertCurrent, transport: { fetch, assertCurrent } };
}

it("signs GetCallerIdentity to the regional STS endpoint and records whose key it is", async () => {
  const fixture = answers({ body: who });
  const saved = await stsKeyFlows.configure(draft(), fixture.transport);
  expect(saved).toMatchObject({
    status: "connected",
    identity: {
      id: "123456789012",
      label: "arn:aws:iam::123456789012:user/Alice",
      kind: "account",
      assurance: "credential-valid",
    },
  });
  const [url, init] = fixture.fetch.mock.calls[0] ?? [];
  expect(String(url)).toBe("https://sts.us-east-1.amazonaws.com/");
  expect(init).toMatchObject({
    method: "POST",
    mode: "cors",
    redirect: "error",
    credentials: "omit",
    body: "Action=GetCallerIdentity&Version=2011-06-15",
  });
  const headers = new Headers(init?.headers);
  expect(headers.get("content-type")).toBe(
    "application/x-www-form-urlencoded; charset=utf-8",
  );
  expect(headers.get("authorization")).toMatch(
    /^AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE\/\d{8}\/us-east-1\/sts\/aws4_request, SignedHeaders=content-type;host;x-amz-date;x-amz-security-token, Signature=[0-9a-f]{64}$/,
  );
  expect(headers.has("host")).toBe(false);
  expect(JSON.stringify(readDeviceRows())).not.toContain(
    "private-signing-secret",
  );
  expect(JSON.stringify(saved)).not.toContain("private-session-token");
  expect(isNativeStsProvider("aws-sts")).toBe(true);
  expect(isNativeStsProvider("aws")).toBe(false);
});

it("refuses a region that is not one, and any endpoint, scope or extra field, before any request", async () => {
  for (const change of [
    { parameters: { ...draft().parameters, region: "evil.example.com/x" } },
    { parameters: { ...draft().parameters, endpoint: "https://evil.test" } },
    { requestedScopes: { app: ["x"] } },
    { targetIds: { region: "us-east-1" } },
    { credentials: { ...draft().credentials, api_key: "x" } },
    { providerId: "aws" },
  ]) {
    const fixture = answers({ body: who });
    await expect(
      stsKeyFlows.configure({ ...draft(), ...change }, fixture.transport),
    ).rejects.toThrow();
    expect(fixture.fetch).not.toHaveBeenCalled();
  }
});

it.each([
  ["InvalidClientTokenId", 403, "refused"],
  ["SignatureDoesNotMatch", 403, "refused"],
  ["ExpiredToken", 403, "refused"],
  ["AccessDenied", 403, "permissions"],
  ["Throttling", 429, "rate limit"],
  ["InternalFailure", 500, "expected response"],
])(
  "classifies STS's %s (%s) as a refusal of the %s, and saves nothing",
  async (code, status, words) => {
    const message =
      "secret detail AWS echoes: arn:aws:iam::123456789012:user/x";
    const fixture = answers({
      body: `<ErrorResponse><Error><Type>Sender</Type><Code>${code}</Code><Message>${message}</Message></Error></ErrorResponse>`,
      status,
    });
    const failure = await stsKeyFlows
      .configure(draft(), fixture.transport)
      .then(
        () => null,
        (error) => error,
      );
    if (!(failure instanceof Error))
      throw new Error("A refused key must throw");
    expect(failure.message.toLowerCase()).toContain(words);
    expect(failure.message).not.toContain(message);
    expect(readDeviceRows()).toEqual([]);
  },
);

it.each([
  "<Nothing/>",
  "<GetCallerIdentityResponse><GetCallerIdentityResult><Account>12</Account></GetCallerIdentityResult></GetCallerIdentityResponse>",
  who.replace("<Account>123456789012</Account>", "<Account>abc</Account>"),
  `<!DOCTYPE x [<!ENTITY a "b">]>${who}`,
  "",
])("does not read a reply that is not a caller identity: %#", async (body) => {
  const fixture = answers({ body });
  await expect(
    stsKeyFlows.configure(draft(), fixture.transport),
  ).rejects.toThrow();
  expect(readDeviceRows()).toEqual([]);
});

it("shows who the key is on request", async () => {
  const saved = await stsKeyFlows.configure(
    draft(),
    answers({ body: who }).transport,
  );
  const fixture = answers({ body: who });
  const result = await stsKeyFlows.invoke(
    saved.connectionId,
    "sts.identity.read",
    {},
    fixture.transport,
  );
  expect(result.items.map((item) => item.label)).toEqual([
    "Account 123456789012",
    "arn:aws:iam::123456789012:user/Alice",
    "User ID AIDACKCEVSQ6C2EXAMPLE",
  ]);
});

it("assumes a role on request and shows its credentials once, never keeping them", async () => {
  const saved = await stsKeyFlows.configure(
    draft(),
    answers({ body: who }).transport,
  );
  const fixture = answers({ body: assumed });
  const result = await stsKeyFlows.invoke(
    saved.connectionId,
    "sts.role.assume",
    { role_arn: "arn:aws:iam::123456789012:role/Deploy" },
    fixture.transport,
  );
  const [, init] = fixture.fetch.mock.calls[0] ?? [];
  expect(String(init?.body)).toBe(
    "Action=AssumeRole&Version=2011-06-15&RoleArn=arn%3Aaws%3Aiam%3A%3A123456789012%3Arole%2FDeploy&RoleSessionName=OpenSesame&DurationSeconds=3600",
  );
  expect(result.items.map((item) => item.id)).toEqual([
    "AccessKeyId",
    "SecretAccessKey",
    "SessionToken",
    "Expiration",
  ]);
  expect(result.items[0]?.secretValue).toBe("ASIAIOSFODNN7EXAMPLE");
  expect(result.items[3]).toEqual({
    id: "Expiration",
    label: "Expires 2026-10-12T19:00:00Z",
  });
  // The record holds the key that signed, never what STS handed back.
  const stored = JSON.stringify(loadNativeConnectorRecord(saved.connectionId));
  expect(stored).not.toContain("wJalrXUtnFEMI");
  expect(JSON.stringify(readNativeConnector(saved.connectionId))).not.toContain(
    "ASIAIOSFODNN7EXAMPLE",
  );
});

it("gets a session token with no input, and refuses a role that is not an IAM role ARN before any request", async () => {
  const saved = await stsKeyFlows.configure(
    draft(),
    answers({ body: who }).transport,
  );
  const token = answers({
    body: assumed.replaceAll("AssumeRole", "GetSessionToken"),
  });
  const result = await stsKeyFlows.invoke(
    saved.connectionId,
    "sts.session-token.get",
    {},
    token.transport,
  );
  expect(String(token.fetch.mock.calls[0]?.[1]?.body)).toBe(
    "Action=GetSessionToken&Version=2011-06-15&DurationSeconds=3600",
  );
  expect(result.items).toHaveLength(4);
  for (const role_arn of [
    "",
    "arn:aws:s3:::bucket",
    "arn:aws:iam::12:role/x",
    "role/x&Action=Delete",
  ]) {
    const fixture = answers({ body: assumed });
    await expect(
      stsKeyFlows.invoke(
        saved.connectionId,
        "sts.role.assume",
        { role_arn },
        fixture.transport,
      ),
    ).rejects.toThrow();
    expect(fixture.fetch).not.toHaveBeenCalled();
  }
});

it("offers only the operations it lists, with exactly the input each takes", async () => {
  const saved = await stsKeyFlows.configure(
    draft(),
    answers({ body: who }).transport,
  );
  const fixture = answers({ body: who });
  for (const [operation, input] of [
    ["sts.unknown", {}],
    ["sts.identity.read", { extra: "x" }],
    ["sts.role.assume", {}],
    [
      "sts.role.assume",
      { role_arn: "arn:aws:iam::123456789012:role/a", more: "x" },
    ],
    ["provider.read", { x: "y" }],
  ] as const)
    await expect(
      stsKeyFlows.invoke(
        saved.connectionId,
        operation,
        { ...input },
        fixture.transport,
      ),
    ).rejects.toThrow();
  expect(fixture.fetch).not.toHaveBeenCalled();
});

it("re-proves with the saved key on provider.read, and a refused key stops looking verified", async () => {
  const saved = await stsKeyFlows.configure(
    draft(),
    answers({ body: who }).transport,
  );
  const ok = await stsKeyFlows.invoke(
    saved.connectionId,
    "provider.read",
    {},
    answers({ body: who }).transport,
  );
  expect(ok.label).toBe("AWS Security Token Service access verified");
  const refused = answers({
    body: "<ErrorResponse><Error><Code>InvalidClientTokenId</Code></Error></ErrorResponse>",
    status: 403,
  });
  await expect(
    stsKeyFlows.invoke(
      saved.connectionId,
      "provider.read",
      {},
      refused.transport,
    ),
  ).rejects.toThrow();
  expect(readNativeConnector(saved.connectionId)?.status).not.toBe("connected");
});

it("forgets the key locally and says it revokes nothing", async () => {
  const saved = await stsKeyFlows.configure(
    draft(),
    answers({ body: who }).transport,
  );
  expect(stsKeyFlows.ui("aws-sts").disconnectExplanation).toContain(
    "revokes nothing",
  );
  expect(stsKeyFlows.cleanup.credentialSlots).toEqual([
    "secret_access_key",
    "session_token",
  ]);
  expect(saved.connectionId).toMatch(/^conn_sts_/);
});
