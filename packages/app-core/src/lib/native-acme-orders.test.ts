import { expect, it } from "vitest";
import { connected } from "./native-acme-connect.test-support.js";
import { acmeKeyFlows, parseAcmeNames } from "./native-acme.js";
import {
  BASE,
  CA_WORDS,
  PEM_CHAIN,
  expectedTxt,
  fakeAcme,
} from "./native-acme.test-support.js";
import { installNativeApiTests } from "./native-api.test-support.js";
import {
  loadNativeConnectorRecord,
  readNativeConnector,
} from "./native-connector-store.js";

installNativeApiTests();

it("opens an order and gives the TXT records, computed from the account key", async () => {
  const { ca, id, jwk } = await connected();
  const result = await acmeKeyFlows.invoke(
    id,
    "certificate.issue",
    { domains: "Example.org, *.example.org\nwww.example.org" },
    ca.transport,
  );
  const [order, ...records] = result.items;
  expect(order?.secretValue).toMatch(
    /^https:\/\/acme-staging-v02\.api\.letsencrypt\.org\/acme\/order\/42\/\d+$/,
  );
  const tokens = [...ca.authzs.values()].map((authz) => authz.token);
  expect(records.map((item) => item.label)).toEqual([
    "TXT _acme-challenge.example.org",
    "TXT _acme-challenge.example.org",
    "TXT _acme-challenge.www.example.org",
  ]);
  // The value is the SHA-256 of "token.thumbprint", base64url, worked out apart from the driver.
  expect(records.map((item) => item.secretValue)).toEqual(
    tokens.map((token) => expectedTxt(token, jwk)),
  );
  expect(ca.calls.at(-1)?.protectedHeader).toHaveProperty(
    "kid",
    `${BASE}/acme/acct/40002`,
  );
});

it("lists names the CA already validated instead of asking for a record", async () => {
  const { ca, id } = await connected({ alreadyValid: ["example.org"] });
  const result = await acmeKeyFlows.invoke(
    id,
    "certificate.issue",
    { domains: "example.org" },
    ca.transport,
  );
  expect(result.items.map((item) => item.label)).toEqual([
    "Order address (paste into Finish)",
    "example.org is already validated",
  ]);
});

it.each([
  "",
  "   ",
  "localhost",
  "exa mple.org!",
  "*.*.example.org",
  "https://example.org",
  Array.from({ length: 21 }, (_, index) => `n${index}.example.org`).join(","),
])("refuses the names %j before any request", async (domains) => {
  const { ca, id } = await connected();
  ca.fetch.mockClear();
  await expect(
    acmeKeyFlows.invoke(id, "certificate.issue", { domains }, ca.transport),
  ).rejects.toThrow();
  expect(ca.fetch).not.toHaveBeenCalled();
  expect(() => parseAcmeNames(domains)).toThrow();
});

it("finishes an order: answers the challenges, finalizes with a request signed here, and hands over the chain and key once", async () => {
  const { ca, id } = await connected({ publish: true });
  const opened = await acmeKeyFlows.invoke(
    id,
    "certificate.issue",
    { domains: "example.org,*.example.org" },
    ca.transport,
  );
  const result = await acmeKeyFlows.invoke(
    id,
    "certificate.finish",
    { order_url: opened.items[0]?.secretValue ?? "" },
    ca.transport,
  );
  const [chain, key] = result.items;
  expect(chain?.secretValue).toBe(PEM_CHAIN);
  expect(key?.secretValue).toMatch(
    /^-----BEGIN PRIVATE KEY-----\n[A-Za-z0-9+/=\n]+-----END PRIVATE KEY-----\n$/,
  );
  // The CA checked the request: its names, and a signature under the key inside it.
  expect(ca.csrs).toHaveLength(1);
  expect(ca.csrs[0]).toMatchObject({
    names: ["example.org", "*.example.org"],
    verified: true,
  });
  // The key handed over is the one the request names.
  const spki = new Uint8Array(
    await crypto.subtle.exportKey(
      "spki",
      await crypto.subtle
        .importKey(
          "pkcs8",
          Uint8Array.from(
            atob((key?.secretValue ?? "").replace(/-----[A-Z ]+-----|\s/g, "")),
            (char) => char.charCodeAt(0),
          ),
          { name: "ECDSA", namedCurve: "P-256" },
          true,
          ["sign"],
        )
        .then(async (imported) => {
          const jwk = await crypto.subtle.exportKey("jwk", imported);
          jwk.d = undefined;
          jwk.key_ops = ["verify"];
          return crypto.subtle.importKey(
            "jwk",
            jwk,
            { name: "ECDSA", namedCurve: "P-256" },
            true,
            ["verify"],
          );
        }),
    ),
  );
  expect(spki).toEqual(ca.csrs[0]?.spki);
  // Nothing of the certificate's key or chain is kept.
  const stored = JSON.stringify(loadNativeConnectorRecord(id));
  expect(stored).not.toContain("BEGIN PRIVATE KEY");
  expect(stored).not.toContain("MIIBleaf");
  const download = ca.calls.at(-1);
  expect(new Headers(download?.init?.headers).get("accept")).toBe(
    "application/pem-certificate-chain",
  );
});

it("says so, in its own words, when the records were not there, and keeps the connection verified", async () => {
  const { ca, id } = await connected({ publish: false });
  const opened = await acmeKeyFlows.invoke(
    id,
    "certificate.issue",
    { domains: "example.org" },
    ca.transport,
  );
  const failure = await acmeKeyFlows
    .invoke(
      id,
      "certificate.finish",
      { order_url: opened.items[0]?.secretValue ?? "" },
      ca.transport,
    )
    .then(
      () => null,
      (error) => error,
    );
  if (!(failure instanceof Error))
    throw new Error("A rejected order must throw");
  expect(failure.message).toContain("start again with Issue");
  expect(failure.message).not.toContain(CA_WORDS);
  expect(readNativeConnector(id)?.status).toBe("connected");
  // The CA never saw a request to finalize.
  expect(ca.csrs).toEqual([]);
});

it("refuses an order that is finished already, since its key cannot be shown twice", async () => {
  const { ca, id } = await connected({ publish: true });
  const opened = await acmeKeyFlows.invoke(
    id,
    "certificate.issue",
    { domains: "example.org" },
    ca.transport,
  );
  const input = { order_url: opened.items[0]?.secretValue ?? "" };
  await acmeKeyFlows.invoke(id, "certificate.finish", input, ca.transport);
  await expect(
    acmeKeyFlows.invoke(id, "certificate.finish", input, ca.transport),
  ).rejects.toThrow("shown only once");
  expect(ca.csrs).toHaveLength(1);
});

it.each([
  "",
  "https://evil.example/acme/order/42/7",
  "http://acme-staging-v02.api.letsencrypt.org/acme/order/42/7",
  `${BASE}/acme/order/42/7?x=1`,
  `${BASE}/acme/order/42/7#frag`,
  `${BASE}/acme/order/42`,
  `${BASE}/acme/order/42/7/extra`,
  `${BASE}/acme/acct/40002`,
  "https://user:pass@acme-staging-v02.api.letsencrypt.org/acme/order/42/7",
  "https://acme-v02.api.letsencrypt.org/acme/order/42/7",
])("refuses the order address %j before any request", async (order_url) => {
  const { ca, id } = await connected();
  ca.fetch.mockClear();
  await expect(
    acmeKeyFlows.invoke(id, "certificate.finish", { order_url }, ca.transport),
  ).rejects.toThrow("order address");
  expect(ca.fetch).not.toHaveBeenCalled();
});

it("treats a CA that no longer knows the account as a refused key, and an unwelcome name as no such thing", async () => {
  const unwelcome = await connected({
    orderProblem: { type: "rejectedIdentifier", status: 400 },
  });
  await expect(
    acmeKeyFlows.invoke(
      unwelcome.id,
      "certificate.issue",
      { domains: "example.org" },
      unwelcome.ca.transport,
    ),
  ).rejects.toThrow("permissions");
  // The name was refused, not the key: the connection still stands.
  expect(readNativeConnector(unwelcome.id)?.status).toBe("connected");

  const gone = await connected();
  const forgotten = fakeAcme({ accountGone: true });
  await expect(
    acmeKeyFlows.invoke(
      gone.id,
      "certificate.issue",
      { domains: "example.org" },
      forgotten.transport,
    ),
  ).rejects.toThrow("refused");
  expect(readNativeConnector(gone.id)?.status).not.toBe("connected");
});

it("offers only the operations it lists, with exactly the input each takes", async () => {
  const { ca, id } = await connected();
  ca.fetch.mockClear();
  for (const [operation, input] of [
    ["certificate.revoke", {}],
    ["certificate.issue", {}],
    ["certificate.issue", { domains: "example.org", extra: "x" }],
    ["certificate.finish", { domains: "example.org" }],
    ["provider.read", { x: "y" }],
  ] as const)
    await expect(
      acmeKeyFlows.invoke(id, operation, { ...input }, ca.transport),
    ).rejects.toThrow();
  expect(ca.fetch).not.toHaveBeenCalled();
});
