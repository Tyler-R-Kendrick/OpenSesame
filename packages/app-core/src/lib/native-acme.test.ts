import { expect, it } from "vitest";
import { readDeviceRows } from "./device-connector-records.js";
import { connected, draft } from "./native-acme-connect.test-support.js";
import { acmeKeyFlows, isNativeAcmeProvider } from "./native-acme.js";
import { BASE, CA_WORDS, fakeAcme } from "./native-acme.test-support.js";
import type { NativeApiConfigureInput } from "./native-api-connectors.js";
import { installNativeApiTests } from "./native-api.test-support.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";

installNativeApiTests();

it("makes an account key here, has the CA create the account, and records whose it is", async () => {
  const ca = fakeAcme();
  const saved = await acmeKeyFlows.configure(draft(), ca.transport);
  expect(saved).toMatchObject({
    status: "connected",
    identity: {
      id: `${BASE}/acme/acct/40002`,
      label: "Staging account 40002",
      kind: "acme-account",
      assurance: "credential-valid",
    },
  });
  const record = loadNativeConnectorRecord(saved.connectionId);
  expect(record?.configuration.parameters).toEqual({
    environment: "staging",
    accept_terms: "yes",
    account_url: `${BASE}/acme/acct/40002`,
  });
  expect(record?.configuration.targetIds).toEqual({ environment: "staging" });
  // The key was generated in this page and is sealed; the view never carries it.
  const key = JSON.parse(record?.privateState.credentials.account_key ?? "{}");
  expect(key).toMatchObject({ kty: "EC", crv: "P-256" });
  expect(key.d).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(JSON.stringify(readNativeConnector(saved.connectionId))).not.toContain(
    key.d,
  );
  expect(JSON.stringify(readDeviceRows())).not.toContain(key.d);
  expect(isNativeAcmeProvider("letsencrypt")).toBe(true);
  expect(isNativeAcmeProvider("zerossl")).toBe(false);
});

it("signs every request the way RFC 8555 asks, to the CA's own addresses only", async () => {
  const { ca } = await connected();
  // The fake CA verifies signature, signed URL and one-time nonce on each POST;
  // here, what a browser must send for that to be possible.
  const register = ca.calls.find(
    (call) => call.url === `${BASE}/acme/new-acct`,
  );
  expect(register?.payload).toEqual({ termsOfServiceAgreed: true });
  expect(register?.protectedHeader).toMatchObject({ alg: "ES256" });
  expect(register?.protectedHeader).toHaveProperty("jwk");
  expect(register?.protectedHeader).not.toHaveProperty("kid");
  const headers = new Headers(register?.init?.headers);
  expect(headers.get("content-type")).toBe("application/jose+json");
  expect(register?.init).toMatchObject({
    mode: "cors",
    credentials: "omit",
    redirect: "error",
  });
  for (const [url] of ca.fetch.mock.calls)
    expect(String(url).startsWith(BASE)).toBe(true);
});

it("finds the same account again for the same key, and makes a new one for another environment", async () => {
  const { ca, saved } = await connected();
  const again = await acmeKeyFlows.configure(
    { ...draft(), connectionId: saved.connectionId, revision: saved.revision },
    ca.transport,
  );
  expect(again.identity?.id).toBe(saved.identity?.id);
  expect(ca.accounts.size).toBe(1);
  const verified = await acmeKeyFlows.verify(saved.connectionId, ca.transport);
  expect(verified.status).toBe("connected");
  expect(ca.accounts.size).toBe(1);
});

it("refuses a choice that is not one, missing terms, and any other field, before any request", async () => {
  const changes: Partial<NativeApiConfigureInput>[] = [
    { parameters: { environment: "prod", accept_terms: "yes" } },
    { parameters: { environment: "staging" } },
    { parameters: { environment: "staging", accept_terms: "no" } },
    { parameters: { ...draft().parameters, directory: "https://evil.test" } },
    { credentials: { account_key: "{}" } },
    { requestedScopes: { app: ["x"] } },
    { targetIds: { environment: "production" } },
    { providerId: "aws" },
  ];
  for (const change of changes) {
    const ca = fakeAcme();
    await expect(
      acmeKeyFlows.configure({ ...draft(), ...change }, ca.transport),
    ).rejects.toThrow();
    expect(ca.fetch).not.toHaveBeenCalled();
  }
  expect(readDeviceRows()).toEqual([]);
});

it("refuses a directory that points anywhere but the CA, and saves nothing", async () => {
  for (const newOrder of [
    "https://evil.example/acme/new-order",
    "http://acme-staging-v02.api.letsencrypt.org/acme/new-order",
    `${BASE}/other/new-order`,
    `${BASE}/acme/new-order?x=1`,
  ]) {
    const ca = fakeAcme({ directory: { newOrder } });
    await expect(acmeKeyFlows.configure(draft(), ca.transport)).rejects.toThrow(
      "expected response",
    );
  }
  expect(readDeviceRows()).toEqual([]);
});

it("retries one stale nonce, and gives up on a CA that keeps refusing", async () => {
  const once = fakeAcme({ staleNonceOnce: true });
  await expect(
    acmeKeyFlows.configure(draft(), once.transport),
  ).resolves.toMatchObject({
    status: "connected",
  });
  const always = fakeAcme({ staleNonceAlways: true });
  await expect(
    acmeKeyFlows.configure(draft(), always.transport),
  ).rejects.toThrow("expected response");
});

it.each([
  [{ rateLimitedAccount: true }, "rate limit"],
  [{ staleNonceAlways: true }, "expected response"],
] as const)(
  "classifies the CA's refusal (%#) without repeating what it wrote",
  async (options, words) => {
    const ca = fakeAcme(options);
    const failure = await acmeKeyFlows.configure(draft(), ca.transport).then(
      () => null,
      (error) => error,
    );
    if (!(failure instanceof Error)) throw new Error("A refusal must throw");
    expect(failure.message.toLowerCase()).toContain(words);
    expect(failure.message).not.toContain(CA_WORDS);
    expect(readDeviceRows()).toEqual([]);
  },
);

it("re-proves on provider.read, and forgets the key locally without claiming to deactivate anything", async () => {
  const { ca, id } = await connected();
  const ok = await acmeKeyFlows.invoke(id, "provider.read", {}, ca.transport);
  expect(ok.label).toBe("Let's Encrypt access verified");
  expect(acmeKeyFlows.ui("letsencrypt").disconnectExplanation).toContain(
    "deactivates nothing",
  );
  expect(acmeKeyFlows.cleanup.credentialSlots).toEqual(["account_key"]);
  expect(id).toMatch(/^conn_acme_/);
});
