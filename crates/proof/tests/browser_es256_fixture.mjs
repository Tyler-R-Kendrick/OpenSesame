import { webcrypto } from "node:crypto";

if (Number(process.versions.node.split(".")[0]) < 22)
  throw new Error("Node 22 or newer is required for the WebCrypto oracle");

const keys = await webcrypto.subtle.generateKey(
  { name: "ECDSA", namedCurve: "P-256" },
  false,
  ["sign", "verify"],
);
const jwk = await webcrypto.subtle.exportKey("jwk", keys.publicKey);
const encode = (value) =>
  Buffer.from(JSON.stringify(value)).toString("base64url");
const header = encode({ typ: "dpop+jwt", alg: "ES256", jwk });
const payload = encode({
  jti: "browser-proof-fixture",
  htm: "POST",
  htu: "https://host.example/api/v1/browser-pairings",
  iat: 1700000000,
});
const input = `${header}.${payload}`;
const signature = await webcrypto.subtle.sign(
  { name: "ECDSA", hash: "SHA-256" },
  keys.privateKey,
  new TextEncoder().encode(input),
);
process.stdout.write(
  `${input}.${Buffer.from(signature).toString("base64url")}`,
);
