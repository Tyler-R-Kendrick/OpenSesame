import { createHmac } from "node:crypto";
import { afterEach, expect, it, vi } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import { installNativeApiTests } from "./native-api.test-support.js";
import { azureAcKeyFlows, isNativeAzureAcProvider } from "./native-azure-ac.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";

installNativeApiTests();
afterEach(() => vi.useRealTimers());

/** Base64 of 32 bytes: the shape of an App Configuration access key secret. */
const SECRET = "c2VjcmV0LWFjY2Vzcy1rZXktZm9yLXRlc3Rpbmc9PT0=";

const draft = (providerId = "azure-ac") => ({
  providerId,
  displayName: "Azure AC",
  parameters: { store: "My-Store-01", access_key_id: "abcd-l0-s0:Zx9" },
  credentials: { access_key_secret: SECRET },
});

function answers(...replies: { body: unknown; status?: number }[]) {
  const fetch = vi.fn<typeof globalThis.fetch>(async () => {
    const reply = replies.shift();
    if (!reply) throw new Error("No Azure response queued");
    return new Response(JSON.stringify(reply.body), {
      status: reply.status ?? 200,
      headers: { "Content-Type": "application/json" },
    });
  });
  const assertCurrent = vi.fn();
  return { fetch, assertCurrent, transport: { fetch, assertCurrent } };
}
const keys = { items: [{ name: "app:setting" }, { name: "feature/flag" }] };

/** The signature Microsoft's HMAC scheme asks for, computed with Node's own HMAC. */
function expectedSignature(init: RequestInit | undefined, url: string) {
  const headers = new Headers(init?.headers);
  const parsed = new URL(url);
  const stringToSign = `GET\n${parsed.pathname}${parsed.search}\n${headers.get("x-ms-date")};${parsed.host};${headers.get("x-ms-content-sha256")}`;
  return createHmac("sha256", Buffer.from(SECRET, "base64"))
    .update(stringToSign)
    .digest("base64");
}

it("signs a real key listing to the store's own address and records the store", async () => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-12T19:00:00Z"));
  const fixture = answers({ body: keys });
  const saved = await azureAcKeyFlows.configure(draft(), fixture.transport);
  expect(saved).toMatchObject({
    status: "connected",
    identity: {
      id: "my-store-01",
      kind: "store",
      assurance: "credential-valid",
    },
  });
  const [url, init] = fixture.fetch.mock.calls[0] ?? [];
  expect(String(url)).toBe(
    "https://my-store-01.azconfig.io/keys?api-version=2023-11-01",
  );
  expect(init).toMatchObject({
    method: "GET",
    mode: "cors",
    redirect: "error",
    credentials: "omit",
  });
  const headers = new Headers(init?.headers);
  expect(headers.get("x-ms-date")).toBe("Mon, 12 Oct 2026 19:00:00 GMT");
  // base64(sha256("")): a GET has no body.
  expect(headers.get("x-ms-content-sha256")).toBe(
    "47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=",
  );
  expect(headers.get("authorization")).toBe(
    `HMAC-SHA256 Credential=abcd-l0-s0:Zx9&SignedHeaders=x-ms-date;host;x-ms-content-sha256&Signature=${expectedSignature(init, String(url))}`,
  );
  expect(headers.has("host")).toBe(false);
  expect(JSON.stringify(readDeviceRows())).not.toContain(SECRET);
  expect(JSON.stringify(saved)).not.toContain(SECRET);
  expect(isNativeAzureAcProvider("azure-app-configuration")).toBe(true);
});

it("connects under the alias the app was asked for and keeps that id", async () => {
  const saved = await azureAcKeyFlows.configure(
    draft("azure-app-configuration"),
    answers({ body: keys }).transport,
  );
  expect(
    loadNativeConnectorRecord(saved.connectionId)?.configuration.providerId,
  ).toBe("azure-app-configuration");
});

it("takes a store name, never an address, and nothing else, before any request", async () => {
  for (const change of [
    { parameters: { ...draft().parameters, store: "evil.example.com/x" } },
    { parameters: { ...draft().parameters, store: "my-store.azconfig.io" } },
    { parameters: { ...draft().parameters, store: "ab" } },
    { parameters: { ...draft().parameters, store: "-bad-store-" } },
    { parameters: { ...draft().parameters, endpoint: "https://evil.test" } },
    { parameters: { ...draft().parameters, access_key_id: "bad id\n" } },
    { credentials: { access_key_secret: "not base64 !!" } },
    { credentials: { access_key_secret: "" } },
    { requestedScopes: { app: ["x"] } },
    { targetIds: { store: "x" } },
    { providerId: "aws" },
  ]) {
    const fixture = answers({ body: keys });
    await expect(
      azureAcKeyFlows.configure({ ...draft(), ...change }, fixture.transport),
    ).rejects.toThrow();
    expect(fixture.fetch).not.toHaveBeenCalled();
  }
});

it.each([
  [401, "refused"],
  [403, "permissions"],
  [429, "rate limit"],
  [500, "expected response"],
])(
  "classifies Azure's %s as a refusal of the %s, never echoing what it says, and saves nothing",
  async (status, words) => {
    const message = "secret detail Azure echoes: subscription 1234";
    const fixture = answers({ body: { error: message }, status });
    const failure = await azureAcKeyFlows
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
  [{ items: "nope" }],
  [{ items: [{ name: 7 }] }],
  [{ items: [{ name: "has\nnewline" }] }],
  [{ items: Array.from({ length: 501 }, (_, i) => ({ name: `k${i}` })) }],
  [[]],
  [{}],
])("does not read a reply that is not a key listing: %#", async (body) => {
  const fixture = answers({ body });
  await expect(
    azureAcKeyFlows.configure(draft(), fixture.transport),
  ).rejects.toThrow();
  expect(readDeviceRows()).toEqual([]);
});

it("lists key names and reads one value once, signed for the exact path, never keeping it", async () => {
  const saved = await azureAcKeyFlows.configure(
    draft(),
    answers({ body: keys }).transport,
  );
  const names = await azureAcKeyFlows.invoke(
    saved.connectionId,
    "provider.names.read",
    {},
    answers({ body: keys }).transport,
  );
  expect(names.items.map((item) => item.id)).toEqual([
    "app:setting",
    "feature/flag",
  ]);

  const fixture = answers({
    body: {
      key: "app:setting",
      value: "hunter2-value",
      content_type: "text/plain",
    },
  });
  const result = await azureAcKeyFlows.invoke(
    saved.connectionId,
    "provider.secret.read",
    { name: "app:setting" },
    fixture.transport,
  );
  const [url, init] = fixture.fetch.mock.calls[0] ?? [];
  expect(String(url)).toBe(
    "https://my-store-01.azconfig.io/kv/app%3Asetting?api-version=2023-11-01",
  );
  expect(new Headers(init?.headers).get("authorization")).toContain(
    `Signature=${expectedSignature(init, String(url))}`,
  );
  expect(result.items[0]?.secretValue).toBe("hunter2-value");
  expect(
    JSON.stringify(loadNativeConnectorRecord(saved.connectionId)),
  ).not.toContain("hunter2-value");
  expect(JSON.stringify(readNativeConnector(saved.connectionId))).not.toContain(
    "hunter2-value",
  );
});

it("offers only the operations it lists, and refuses a key name that is not one before any request", async () => {
  const saved = await azureAcKeyFlows.configure(
    draft(),
    answers({ body: keys }).transport,
  );
  const fixture = answers({ body: { value: "x" } });
  for (const [operation, input] of [
    ["provider.unknown", {}],
    ["provider.names.read", { extra: "x" }],
    ["provider.secret.read", {}],
    ["provider.secret.read", { name: "" }],
    ["provider.secret.read", { name: ".." }],
    ["provider.secret.read", { name: "bad\nname" }],
  ] as const)
    await expect(
      azureAcKeyFlows.invoke(
        saved.connectionId,
        operation,
        { ...input },
        fixture.transport,
      ),
    ).rejects.toThrow();
  expect(fixture.fetch).not.toHaveBeenCalled();
});

it("re-proves on provider.read, and a refused key stops looking verified", async () => {
  const saved = await azureAcKeyFlows.configure(
    draft(),
    answers({ body: keys }).transport,
  );
  const ok = await azureAcKeyFlows.invoke(
    saved.connectionId,
    "provider.read",
    {},
    answers({ body: keys }).transport,
  );
  expect(ok.label).toBe("Azure App Configuration access verified");
  await expect(
    azureAcKeyFlows.invoke(
      saved.connectionId,
      "provider.read",
      {},
      answers({ body: {}, status: 401 }).transport,
    ),
  ).rejects.toThrow();
  expect(readNativeConnector(saved.connectionId)?.status).not.toBe("connected");
});
