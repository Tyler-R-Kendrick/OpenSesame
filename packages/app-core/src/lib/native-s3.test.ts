import { expect, it, vi } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import { installNativeApiTests } from "./native-api.test-support.js";
import {
  registerNativeProviderCleanup,
  removeNativeConnectorWithCleanup,
} from "./native-connector-lifecycle.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";
import { nativeUploadedIcon } from "./native-icon.test-support.js";
import {
  configureNativeS3,
  invokeNativeS3,
  nativeS3Cleanup,
  verifyNativeS3,
} from "./native-s3.js";

installNativeApiTests();
const draft = () => ({
  providerId: "s3",
  displayName: "S3",
  parameters: {
    endpoint: "https://minio.example.test",
    bucket: "test-bucket",
    region: "us-east-1",
    access_key_id: "public-key-id",
    prefix: "",
  },
  credentials: {
    secret_access_key: "private-signing-secret",
    session_token: "private-session-token",
  },
});
const xml =
  '<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>test-bucket</Name><Prefix/><IsTruncated>false</IsTruncated><Contents><Key>sealed/document</Key></Contents></ListBucketResult>';
it("persists a valid uploaded PNG larger than the provider-text limit", async () => {
  const fixture = answers({ body: xml });
  expect(nativeUploadedIcon.length).toBeGreaterThan(4096);
  const saved = await configureNativeS3(
    { ...draft(), icon: nativeUploadedIcon },
    fixture.transport,
  );
  expect(saved.configuration.icon).toBe(nativeUploadedIcon);
  expect(readNativeConnector(saved.connectionId)?.configuration.icon).toBe(
    nativeUploadedIcon,
  );
});
function answers(...replies: { body: string; status?: number }[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const reply = replies.shift();
    if (!reply) throw new Error("No S3 response queued");
    return new Response(reply.body, {
      status: reply.status ?? 200,
      headers: { "Content-Type": "application/xml" },
    });
  });
  const assertCurrent = vi.fn();
  return { fetch, assertCurrent, transport: { fetch, assertCurrent } };
}
it("signs an actual bounded S3 listing before sealing permission proof and never invents account identity", async () => {
  const fixture = answers({ body: xml }, { body: xml });
  const saved = await configureNativeS3(draft(), fixture.transport);
  expect(saved).toMatchObject({
    status: "connected",
    identity: {
      id: "test-bucket",
      kind: "bucket",
      assurance: "credential-valid",
    },
    grants: [{ permissionState: "provider-managed", grantedScopes: [] }],
  });
  const request = fixture.fetch.mock.calls[0];
  expect(String(request?.[0])).toBe(
    "https://minio.example.test/test-bucket/?list-type=2&max-keys=100&prefix=",
  );
  expect(request?.[1]).toMatchObject({
    method: "GET",
    mode: "cors",
    redirect: "error",
    credentials: "omit",
  });
  const headers = new Headers(request?.[1]?.headers);
  expect(headers.get("Authorization")).toMatch(
    /^AWS4-HMAC-SHA256 Credential=public-key-id\//,
  );
  expect(headers.get("x-amz-security-token")).toBe("private-session-token");
  expect(headers.has("host")).toBe(false);
  expect(JSON.stringify(readDeviceRows())).not.toContain(
    "private-signing-secret",
  );
  expect(JSON.stringify(saved)).not.toContain("private-session-token");
  const result = await invokeNativeS3(
    saved.connectionId,
    "provider.objects.read",
    {},
    fixture.transport,
  );
  expect(result.items).toEqual([
    { id: "sealed/document", label: "sealed/document" },
  ]);
});
it.each([401, 403, 500])(
  "refuses status %s without saving a configuration-only connection",
  async (status) => {
    const fixture = answers({
      body: "<Error><Code>AccessDenied</Code></Error>",
      status,
    });
    await expect(
      configureNativeS3(draft(), fixture.transport),
    ).rejects.toThrow();
    expect(readDeviceRows()).toEqual([]);
  },
);
it.each([
  xml.replace("test-bucket", "wrong-bucket"),
  xml.replace("<Prefix/>", "<Prefix>other/</Prefix>"),
  xml.replace("<IsTruncated>false</IsTruncated>", ""),
  "<html>Sign in</html>",
  `${xml}${"x".repeat(256 * 1024)}`,
])(
  "rejects malformed, mismatched, and oversized bucket responses",
  async (body) => {
    await expect(
      configureNativeS3(draft(), answers({ body }).transport),
    ).rejects.toThrow();
    expect(readDeviceRows()).toEqual([]);
  },
);
it("invalidates a verified bucket when its actual permission is lost and rejects stale writes", async () => {
  const fixture = answers({ body: xml }, { body: "denied", status: 403 });
  const saved = await configureNativeS3(draft(), fixture.transport);
  await expect(
    verifyNativeS3(saved.connectionId, fixture.transport),
  ).rejects.toThrow("permissions");
  expect(readNativeConnector(saved.connectionId)?.status).not.toBe("connected");
  await expect(
    configureNativeS3(
      {
        ...draft(),
        connectionId: saved.connectionId,
        revision: saved.revision,
      },
      fixture.transport,
    ),
  ).rejects.toThrow("changed");
});
it("forgets manually shared S3 credentials through real cleanup without revoking other users' key", async () => {
  const fixture = answers({ body: xml });
  const saved = await configureNativeS3(draft(), fixture.transport);
  const release = registerNativeProviderCleanup("s3", nativeS3Cleanup);
  try {
    await removeNativeConnectorWithCleanup(saved.connectionId);
  } finally {
    release();
  }
  expect(loadNativeConnectorRecord(saved.connectionId)).toBeNull();
  expect(fixture.fetch).toHaveBeenCalledOnce();
});
it("rejects captured transport disposal before a verified result can be persisted", async () => {
  const fixture = answers({ body: xml });
  let calls = 0;
  fixture.assertCurrent.mockImplementation(() => {
    if (++calls > 2) throw new Error("Lease disposed");
  });
  await expect(configureNativeS3(draft(), fixture.transport)).rejects.toThrow();
  expect(readDeviceRows()).toEqual([]);
});

it("preserves the old binding after a refused endpoint edit, but clears proof when the same saved bucket denies access", async () => {
  const fixture = answers(
    { body: xml },
    { body: "denied", status: 403 },
    { body: "denied", status: 403 },
  );
  const saved = await configureNativeS3(draft(), fixture.transport);
  const edit = {
    ...draft(),
    connectionId: saved.connectionId,
    revision: saved.revision,
    credentials: {},
  };
  await expect(
    configureNativeS3(
      {
        ...edit,
        parameters: {
          ...edit.parameters,
          endpoint: "https://other.example.test",
        },
      },
      fixture.transport,
    ),
  ).rejects.toThrow("permissions");
  expect(readNativeConnector(saved.connectionId)?.status).toBe("connected");
  await expect(configureNativeS3(edit, fixture.transport)).rejects.toThrow(
    "permissions",
  );
  expect(readNativeConnector(saved.connectionId)?.status).not.toBe("connected");
});

it("replaces temporary credentials with a permanent key without reusing the previous session token", async () => {
  const fixture = answers({ body: xml }, { body: xml });
  const saved = await configureNativeS3(draft(), fixture.transport);
  await configureNativeS3(
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
  expect(
    loadNativeConnectorRecord(saved.connectionId)?.privateState.credentials
      .session_token,
  ).toBe("");
});
