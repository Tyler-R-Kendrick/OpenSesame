/** Actual HTTPS oracle qualification; no emitted-PWA/browser success is claimed here. */
import { generateKeyPairSync, sign } from "node:crypto";
import { request } from "node:https";
import { afterEach, expect, it } from "vitest";
import { startGoogleWalletBrowserAuthority } from "./google-wallet-browser-authority.mjs";
import {
  GOOGLE_WALLET_CLASS,
  GOOGLE_WALLET_CLASS_URL,
  GOOGLE_WALLET_ISSUER,
  GOOGLE_WALLET_SAVE_PREFIX,
  GOOGLE_WALLET_TOKEN_URL,
} from "./google-wallet-browser-protocol.mjs";
import { googleWalletBrowserArguments } from "./google-wallet-browser-tls.mjs";

const origin = "https://tyler-r-kendrick.github.io";
const closes = [];
afterEach(async () => {
  for (const close of closes.splice(0).reverse()) await close();
});
async function fixture() {
  const value = await startGoogleWalletBrowserAuthority({ origin });
  closes.push(() => value.close());
  return value;
}
function jwt(payload, privateKey) {
  const encode = (value) =>
    Buffer.from(JSON.stringify(value)).toString("base64url");
  const body = `${encode({ alg: "RS256", typ: "JWT" })}.${encode(payload)}`;
  return `${body}.${sign("RSA-SHA256", Buffer.from(body), privateKey).toString("base64url")}`;
}
function assertion(f, privateKey = JSON.parse(f.account).private_key) {
  const now = Math.floor(Date.now() / 1000);
  return new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion: jwt(
      {
        iss: JSON.parse(f.account).client_email,
        aud: GOOGLE_WALLET_TOKEN_URL,
        scope: "https://www.googleapis.com/auth/wallet_object.issuer",
        iat: now,
        exp: now + 3600,
      },
      privateKey,
    ),
  }).toString();
}
function call(
  f,
  target,
  { method = "GET", body, signal, ca = f.tls.cert, headers = {} } = {},
) {
  const url = new URL(target);
  return new Promise((resolve, reject) => {
    const outgoing = request({
      hostname: "127.0.0.1",
      port: f.port,
      servername: url.hostname,
      path: `${url.pathname}${url.search}`,
      method,
      ca,
      rejectUnauthorized: true,
      signal,
      headers: { host: url.host, origin, ...headers },
    });
    outgoing.setTimeout(10000, () =>
      outgoing.destroy(new Error("Oracle request deadline")),
    );
    outgoing.on("error", reject);
    outgoing.on("response", (response) => {
      const tlsAuthorized = response.socket.authorized;
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("error", reject);
      response.on("end", () =>
        resolve({
          status: response.statusCode,
          headers: response.headers,
          body: Buffer.concat(chunks).toString(),
          tlsAuthorized,
        }),
      );
    });
    outgoing.end(body);
  });
}
async function token(f) {
  const reply = await call(f, GOOGLE_WALLET_TOKEN_URL, {
    method: "POST",
    body: assertion(f),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  expect(reply.status).toBe(200);
  expect(reply.tlsAuthorized).toBe(true);
  return JSON.parse(reply.body).access_token;
}
it("verifies a real RS256 issuer grant and exact class through certificate-verified HTTPS", async () => {
  const f = await fixture();
  const access = await token(f);
  const reply = await call(f, GOOGLE_WALLET_CLASS_URL, {
    headers: { authorization: `Bearer ${access}` },
  });
  expect(reply.status).toBe(200);
  expect(reply.tlsAuthorized).toBe(true);
  expect(reply.headers["access-control-allow-origin"]).toBe(origin);
  expect(JSON.parse(reply.body)).toEqual({ id: GOOGLE_WALLET_CLASS });
  expect(f.snapshot().assertions).toBe(1);
  expect(f.snapshot().rows.map((row) => row.authorized)).toEqual([true, true]);
  expect(f.snapshot().rows.map((row) => row.tlsServername)).toEqual([
    "oauth2.googleapis.com",
    "walletobjects.googleapis.com",
  ]);
});
it("serves the exact actual class preflight without credentials", async () => {
  const f = await fixture();
  const reply = await call(f, GOOGLE_WALLET_CLASS_URL, {
    method: "OPTIONS",
    headers: {
      "access-control-request-method": "GET",
      "access-control-request-headers": "authorization",
    },
  });
  expect(reply.status).toBe(204);
  expect(reply.headers["access-control-allow-origin"]).toBe(origin);
  expect(reply.headers["access-control-allow-headers"]).toContain(
    "authorization",
  );
  expect(f.snapshot().assertions).toBe(0);
});
it("does not waive certificate verification", async () => {
  const f = await fixture();
  await expect(call(f, GOOGLE_WALLET_TOKEN_URL, { ca: [] })).rejects.toThrow();
  expect(f.snapshot().rows).toEqual([]);
});
it("rejects a foreign signing key before issuing provider authority", async () => {
  const f = await fixture();
  const wrong = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const reply = await call(f, GOOGLE_WALLET_TOKEN_URL, {
    method: "POST",
    body: assertion(f, wrong.privateKey),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
  expect(reply.status).toBe(401);
  expect(f.snapshot().issuedTokens).toBe(0);
});
it.each(["token", "class"])(
  "physically closes an actual held %s HTTPS body on caller abort",
  async (stage) => {
    const f = await fixture();
    const access = stage === "class" ? await token(f) : null;
    const held = f.holdNext(stage);
    const owner = new AbortController();
    const operation = call(
      f,
      stage === "token" ? GOOGLE_WALLET_TOKEN_URL : GOOGLE_WALLET_CLASS_URL,
      stage === "token"
        ? {
            method: "POST",
            body: assertion(f),
            signal: owner.signal,
            headers: { "content-type": "application/x-www-form-urlencoded" },
          }
        : {
            signal: owner.signal,
            headers: { authorization: `Bearer ${access}` },
          },
    );
    const denied = expect(operation).rejects.toThrow();
    await held.arrived;
    const started = Date.now();
    owner.abort();
    await denied;
    await held.closed;
    expect(Date.now() - started).toBeLessThan(2000);
    expect(f.snapshot().rows.at(-1)?.cancelled).toBe(true);
    held.release();
  },
);
it("validates the signed public Save URL only when an actual navigation requests it", async () => {
  const f = await fixture();
  const payload = {
    iss: JSON.parse(f.account).client_email,
    aud: "google",
    typ: "savetowallet",
    iat: Math.floor(Date.now() / 1000),
    origins: [origin],
    payload: {
      genericObjects: [
        {
          id: `${GOOGLE_WALLET_ISSUER}.os_${"a".repeat(32)}`,
          classId: GOOGLE_WALLET_CLASS,
          state: "ACTIVE",
          cardTitle: {
            defaultValue: { language: "en-US", value: "Research access" },
          },
          header: {
            defaultValue: { language: "en-US", value: "Operator pass" },
          },
        },
      ],
    },
  };
  const url =
    GOOGLE_WALLET_SAVE_PREFIX + jwt(payload, JSON.parse(f.account).private_key);
  expect(f.protocol.inspectSave(url)).toEqual(payload);
  expect(f.snapshot().saved).toEqual([]);
  const reply = await call(f, url);
  expect(reply.status).toBe(200);
  expect(reply.tlsAuthorized).toBe(true);
  expect(reply.body).toContain("Controlled fixture only");
  expect(f.snapshot().saved).toEqual([
    `${GOOGLE_WALLET_ISSUER}.os_${"a".repeat(32)}`,
  ]);
});

it("represents public Google authorities without weakening browser security", () => {
  const args = googleWalletBrowserArguments(43123, "public-spki");
  expect(args).toContain("--no-proxy-server");
  expect(args).toContain(
    "--host-resolver-rules=MAP oauth2.googleapis.com 127.0.0.1:43123, MAP walletobjects.googleapis.com 127.0.0.1:43123, MAP pay.google.com 127.0.0.1:43123",
  );
  expect(args).toContain("--ignore-certificate-errors-spki-list=public-spki");
  expect(args).toContain("--ip-address-space-overrides=127.0.0.1:43123=public");
  expect(args.join(" ")).not.toMatch(
    /disable-web-security|allow-insecure-localhost|LocalNetworkAccessChecks/,
  );
});
