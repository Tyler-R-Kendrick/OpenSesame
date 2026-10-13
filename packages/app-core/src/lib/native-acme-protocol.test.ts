import { expect, it } from "vitest";
import {
  acmeAccountKey,
  acmeDnsTxtValue,
  acmeOwn,
  generateAcmeAccountJwk,
} from "./native-acme-protocol.js";
import { expectedTxt, jwkThumbprint } from "./native-acme.test-support.js";

it("makes a P-256 key whose thumbprint is the RFC 7638 one", async () => {
  const text = await generateAcmeAccountJwk();
  const key = await acmeAccountKey(text);
  const jwk = JSON.parse(text);
  expect(key.jwk).toEqual({ crv: "P-256", kty: "EC", x: jwk.x, y: jwk.y });
  expect(key.thumbprint).toBe(jwkThumbprint(jwk));
  // The public half is all that is ever sent: the private member stays out of it.
  expect(JSON.stringify(key.jwk)).not.toContain(jwk.d);
  expect(
    await acmeDnsTxtValue("evaGxfADs6pSRb2LAv9IZf17Dt3juxGJ-PCt92wr-oA", key),
  ).toBe(expectedTxt("evaGxfADs6pSRb2LAv9IZf17Dt3juxGJ-PCt92wr-oA", jwk));
});

it("makes a different key each time", async () => {
  expect(await generateAcmeAccountJwk()).not.toBe(
    await generateAcmeAccountJwk(),
  );
});

it.each([
  "",
  "not json",
  "{}",
  '{"kty":"RSA"}',
  '{"kty":"EC","crv":"P-384","x":"a","y":"b","d":"c"}',
  '{"kty":"EC","crv":"P-256","x":"a","y":"b"}',
  '{"kty":"EC","crv":"P-256","x":"a","y":"b","d":"c"}',
])(
  "will not sign with the saved key %j, and says to connect again",
  async (text) => {
    await expect(acmeAccountKey(text)).rejects.toThrow("connect again");
  },
);

it("holds an address to the CA's host, HTTPS, the /acme/ tree, and nothing else", () => {
  const own = acmeOwn("production");
  expect(own("https://acme-v02.api.letsencrypt.org/acme/new-order")).toBe(true);
  for (const other of [
    "https://acme-staging-v02.api.letsencrypt.org/acme/new-order",
    "http://acme-v02.api.letsencrypt.org/acme/new-order",
    "https://acme-v02.api.letsencrypt.org/directory",
    "https://acme-v02.api.letsencrypt.org/acme/x?y=1",
    "https://acme-v02.api.letsencrypt.org/acme/x#y",
    "https://u:p@acme-v02.api.letsencrypt.org/acme/x",
    "https://acme-v02.api.letsencrypt.org.evil.test/acme/x",
    "https://evil.test/acme/x",
    `https://acme-v02.api.letsencrypt.org/acme/${"a".repeat(600)}`,
    "/acme/new-order",
    "",
    undefined,
    42,
  ])
    expect(own(other)).toBe(false);
});
