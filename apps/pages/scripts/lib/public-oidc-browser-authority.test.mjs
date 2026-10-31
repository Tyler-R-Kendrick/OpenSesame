/** Independent HTTPS oracle contract; compiled-browser acceptance is separate. */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash, createPublicKey, verify } from "node:crypto";
import fs from "node:fs";
import { request } from "node:https";
import { tmpdir } from "node:os";
import path from "node:path";
import { it } from "vitest";
import {
  BASE,
  PWA,
  PublicOidcAuthority,
} from "./public-oidc-browser-authority.mjs";

function wire(authority, target, method = "GET", payload = "") {
  const url = new URL(target);
  return new Promise((resolve, reject) => {
    const outgoing = request(
      {
        hostname: "127.0.0.1",
        port: authority.port,
        servername: url.hostname,
        ca: authority.tls.cert,
        path: `${url.pathname}${url.search}`,
        method,
        headers: {
          Host: url.hostname,
          Origin: PWA,
          "Content-Type": "application/x-www-form-urlencoded",
          Connection: "close",
        },
      },
      (incoming) => {
        const chunks = [];
        incoming.on("data", (part) => chunks.push(part));
        incoming.on("end", () =>
          resolve({
            status: incoming.statusCode,
            headers: incoming.headers,
            body: Buffer.concat(chunks).toString(),
          }),
        );
      },
    );
    outgoing.once("error", reject);
    outgoing.end(payload);
  });
}

it("independent HTTPS provider verifies S256 and signs ES256 with real CORS headers", async () => {
  const dist = fs.mkdtempSync(path.join(tmpdir(), "public-oidc-oracle-unit-"));
  fs.writeFileSync(
    path.join(dist, "index.html"),
    "<!doctype html><title>Unit static root</title>",
  );
  const authority = await new PublicOidcAuthority(dist).start();
  try {
    const favicon = await wire(authority, `${PWA}/favicon.ico`);
    assert.equal(favicon.status, 404);
    assert.deepEqual(authority.errors, []);
    const config = authority.add("unit");
    const verifier = "v".repeat(43);
    const fields = new URLSearchParams({
      client_id: config.clientId,
      redirect_uri: `${PWA}${BASE}auth/native-connector.html`,
      response_type: "code",
      code_challenge_method: "S256",
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      state: "s".repeat(32),
      nonce: "n".repeat(32),
      scope: "openid profile",
      organization: "org_browser",
    });
    const consent = await wire(
      authority,
      config.authorization,
      "POST",
      fields.toString(),
    );
    assert.equal(consent.status, 302);
    const callback = new URL(consent.headers.location);
    authority.fault(config.id, "cors");
    const reply = await wire(
      authority,
      config.token,
      "POST",
      new URLSearchParams({
        client_id: config.clientId,
        redirect_uri: fields.get("redirect_uri"),
        grant_type: "authorization_code",
        code: callback.searchParams.get("code"),
        code_verifier: verifier,
      }).toString(),
    );
    assert.equal(reply.status, 200);
    assert.equal(reply.headers["access-control-allow-origin"], undefined);
    const token = JSON.parse(reply.body).id_token.split(".");
    const keys = JSON.parse((await wire(authority, config.jwks)).body).keys;
    assert.equal(
      verify(
        "sha256",
        Buffer.from(token.slice(0, 2).join(".")),
        {
          key: createPublicKey({ key: keys[0], format: "jwk" }),
          dsaEncoding: "ieee-p1363",
        },
        Buffer.from(token[2], "base64url"),
      ),
      true,
    );
    assert.equal(
      JSON.parse(Buffer.from(token[1], "base64url").toString("utf8")).nonce,
      fields.get("nonce"),
    );
    assert.deepEqual(authority.errors, []);
    assert.equal(authority.stats(config.id).tokens, 1);
  } finally {
    await authority.close();
    fs.rmSync(dist, { recursive: true });
  }
}, 30000);
