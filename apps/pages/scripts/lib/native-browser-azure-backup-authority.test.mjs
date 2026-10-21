/** @vitest-environment node */
import {
  azureSecretBundle,
  azureSecretReference,
  azureVaultBase,
} from "@opensesame/app-core/lib/secret-backends/azure-key-vault-codec.js";
import { expect, it } from "vitest";
import { createAzureBackupAuthority } from "./native-browser-azure-backup-authority.mjs";
import {
  AZURE_SECRETS_FIXTURE as f,
  routeNativeAzureSecretsAuthority,
} from "./native-browser-azure-secrets.mjs";

function fixture() {
  const authority = {
    state: { calls: [], reject: new Set(), expectedResponses: new WeakMap() },
  };
  const owner = createAzureBackupAuthority(f, authority, {
    check: (ok) => expect(ok).toBe(true),
  });
  return {
    authority,
    dispatch({
      path = "/secrets/opensesame-browser-backup-desktop",
      method = "GET",
      body = null,
      headers = {},
      query = "?api-version=2025-07-01",
      origin = f.vaultURL,
    } = {}) {
      const request = {
        url: () => `${origin}${path}${query}`,
        method: () => method,
        postData: () => body,
      };
      return owner.dispatch(request, {
        accept: "application/json",
        authorization: `Bearer ${f.token}`,
        "content-type": "application/json",
        ...headers,
      });
    },
  };
}
it("returns newly versioned official bundles and exact logical/versioned readback without changing caller bytes", () => {
  const o = fixture();
  expect(o.dispatch().status).toBe(404);
  const first = o.dispatch({
    method: "PUT",
    body: JSON.stringify({ value: "first controlled secret" }),
  });
  expect(first.status).toBe(200);
  const bundle = JSON.parse(first.body);
  const base = azureVaultBase(f.vaultURL);
  expect(
    azureSecretBundle(
      bundle,
      base,
      azureSecretReference("opensesame-browser-backup-desktop", base),
    ),
  ).toEqual(bundle);
  expect(JSON.parse(o.dispatch().body)).toEqual(bundle);
  const second = JSON.parse(
    o.dispatch({
      method: "PUT",
      body: JSON.stringify({ value: "second controlled secret" }),
    }).body,
  );
  expect(second.id).not.toBe(bundle.id);
  expect(
    JSON.parse(o.dispatch({ path: new URL(bundle.id).pathname }).body),
  ).toEqual(bundle);
  expect(JSON.parse(o.dispatch().body)).toEqual(second);
  expect(o.authority.azureBackup.saved.size).toBe(1);
});
it.each([
  { origin: "https://foreign.vault.azure.net" },
  { path: "/secrets/api-key", method: "PUT", body: "{}" },
  { path: "/keys/opensesame-browser-backup-desktop" },
  { path: "/secrets/opensesame-browser-backup-unbounded" },
  { query: "?api-version=7.4" },
  { query: "?api-version=2025-07-01&url=https://foreign.example" },
  { method: "DELETE" },
  { method: "POST" },
  { body: "{}" },
  { headers: { cookie: "ambient=credential" } },
  { method: "PUT", headers: { "content-type": "text/plain" }, body: "{}" },
  {
    method: "PUT",
    path: `/secrets/opensesame-browser-backup-desktop/${"a".repeat(32)}`,
    body: "{}",
  },
])(
  "leaves unsupported route/headers/method for existing refusal handling %#",
  (input) => {
    const o = fixture();
    expect(o.dispatch(input)).toBeNull();
    expect(o.authority.state.calls).toEqual([]);
    expect(o.authority.azureBackup.saved.size).toBe(0);
  },
);
it.each([
  "not JSON",
  "null",
  "[]",
  "{}",
  '{"value":12}',
  '{"value":"ok","token":"forbidden"}',
  JSON.stringify({ value: "é".repeat(12801) }),
])("refuses malformed/oversized write without storing a version %#", (body) => {
  const o = fixture();
  expect(o.dispatch({ method: "PUT", body }).status).toBe(400);
  expect(o.authority.azureBackup.saved.size).toBe(0);
});
it.each(["Bearer wrong-audience", "Basic wrong", ""])(
  "refuses an unaccepted credential before reading or changing the vault %#",
  (authorization) => {
    const o = fixture();
    const reply = o.dispatch({
      method: "PUT",
      body: '{"value":"controlled"}',
      headers: { authorization },
    });
    expect(reply.status).toBe(401);
    expect(o.authority.azureBackup.saved.size).toBe(0);
    expect(JSON.stringify(o.authority.state.calls)).not.toContain(
      authorization || "Basic",
    );
  },
);
it("accepts the actual25KiB boundary and keeps independent context state", () => {
  const first = fixture();
  expect(
    first.dispatch({
      method: "PUT",
      body: JSON.stringify({ value: "a".repeat(25600) }),
    }).status,
  ).toBe(200);
  const second = fixture();
  expect(second.dispatch().status).toBe(404);
  expect(second.authority.azureBackup.saved.size).toBe(0);
});
it("includes newly stored logical backup names in the actual routed collection without exposing their values", async () => {
  let handler;
  const authority = {
    state: { calls: [], reject: new Set(), expectedResponses: new WeakMap() },
  };
  await routeNativeAzureSecretsAuthority(
    {
      route: async (_match, callback) => {
        handler = callback;
      },
    },
    authority,
    { check: (ok) => expect(ok).toBe(true) },
  );
  async function request(path, method, body) {
    let reply;
    await handler({
      request: () => ({
        url: () => `${f.vaultURL}${path}`,
        method: () => method,
        postData: () => body,
        allHeaders: async () => ({
          authorization: `Bearer ${f.token}`,
          accept: "application/json",
          "content-type": "application/json",
        }),
      }),
      fulfill: async (value) => {
        reply = value;
      },
      fallback: async () => {
        throw new Error("Unexpected Azure fallback");
      },
    });
    return reply;
  }
  const written = await request(
    "/secrets/opensesame-browser-backup-phone?api-version=2025-07-01",
    "PUT",
    JSON.stringify({ value: "private controlled backup bytes" }),
  );
  expect(written.status).toBe(200);
  const listed = await request(
    "/secrets?api-version=2025-07-01&maxresults=25",
    "GET",
    null,
  );
  expect(JSON.parse(listed.body).value.map((item) => item.id)).toEqual([
    `${f.vaultURL}/secrets/api-key`,
    `${f.vaultURL}/secrets/opensesame-browser-backup-phone`,
  ]);
  expect(listed.body).not.toContain("private controlled backup bytes");
});
