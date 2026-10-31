/** Independent provider state, one-use PKCE grants and Node ES256 assertions. */
import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import {
  createHash,
  generateKeyPairSync,
  randomBytes,
  sign,
} from "node:crypto";

export const PWA = "https://pwa.public-oidc.test";
export const IDP = "https://idp.public-oidc.test";
export const BASE = "/OpenSesame/";
const CLIENT = "compiled-public-browser-client";
const CALLBACK = `${PWA}${BASE}auth/native-connector.html`;

export class PublicOidcProtocol {
  #codes = new Map();
  #cases = new Map();
  constructor() {
    this.keys = generateKeyPairSync("ec", { namedCurve: "P-256" });
  }
  add(id) {
    assert.match(id, /^[a-z0-9-]+$/);
    assert.ok(!this.#cases.has(id));
    const value = {
      id,
      mode: "ok",
      name: `Browser OIDC Person ${id}`,
      issuer: `${IDP}/case/${id}`,
      authorized: 0,
      tokens: 0,
      verifications: [],
    };
    this.#cases.set(id, value);
    return {
      ...value,
      clientId: CLIENT,
      authorization: `${value.issuer}/authorize`,
      token: `${value.issuer}/token`,
      jwks: `${value.issuer}/jwks`,
    };
  }
  get(id) {
    const value = this.#cases.get(id);
    assert.ok(value);
    return value;
  }
  fault(id, mode) {
    assert.ok(["ok", "nonce", "organization", "cors"].includes(mode));
    this.get(id).mode = mode;
  }
  stats(id) {
    const value = this.get(id);
    return {
      authorized: value.authorized,
      tokens: value.tokens,
      verifications: value.verifications.map((row) => ({ ...row })),
    };
  }
  authorize(fields, value) {
    assert.equal(fields.get("client_id"), CLIENT);
    assert.equal(fields.get("redirect_uri"), CALLBACK);
    assert.equal(fields.get("response_type"), "code");
    assert.equal(fields.get("code_challenge_method"), "S256");
    assert.equal(fields.get("organization"), "org_browser");
    assert.ok(fields.get("scope")?.split(/\s+/).includes("openid"));
    assert.match(fields.get("state") ?? "", /^[A-Za-z0-9_-]{16,512}$/);
    assert.match(fields.get("nonce") ?? "", /^[A-Za-z0-9_-]{16,512}$/);
    assert.match(fields.get("code_challenge") ?? "", /^[A-Za-z0-9_-]{43}$/);
    return {
      id: value.id,
      state: fields.get("state"),
      nonce: fields.get("nonce"),
      challenge: fields.get("code_challenge"),
      used: false,
    };
  }
  consent(fields, value) {
    const grant = this.authorize(fields, value);
    const code = randomBytes(24).toString("base64url");
    this.#codes.set(code, grant);
    value.authorized++;
    const callback = new URL(CALLBACK);
    callback.searchParams.set("state", grant.state);
    callback.searchParams.set("code", code);
    return callback.href;
  }
  jwks() {
    return {
      keys: [
        {
          ...this.keys.publicKey.export({ format: "jwk" }),
          kid: "independent-browser-es256",
          alg: "ES256",
          use: "sig",
        },
      ],
    };
  }
  token(fields, value) {
    const code = this.#codes.get(fields.get("code"));
    assert.ok(
      code && code.id === value.id && !code.used,
      "One original unspent authorization code",
    );
    assert.equal(fields.get("client_id"), CLIENT);
    assert.equal(fields.get("grant_type"), "authorization_code");
    assert.equal(fields.get("redirect_uri"), CALLBACK);
    assert.equal(fields.has("client_secret"), false);
    assert.equal(
      createHash("sha256")
        .update(fields.get("code_verifier") ?? "")
        .digest("base64url"),
      code.challenge,
    );
    code.used = true;
    value.tokens++;
    value.verifications.push({
      oneUseCode: true,
      pkceS256: true,
      client: true,
      callback: true,
      authentication: "none",
    });
    return this.assertion(code, value);
  }
  assertion(code, value) {
    const now = Math.floor(Date.now() / 1000);
    const encoded = [
      { alg: "ES256", kid: "independent-browser-es256", typ: "JWT" },
      {
        iss: value.issuer,
        aud: CLIENT,
        sub: `person-${value.id}`,
        name: value.name,
        nonce: value.mode === "nonce" ? "wrong-signed-nonce" : code.nonce,
        org_id:
          value.mode === "organization"
            ? "wrong-signed-organization"
            : "org_browser",
        auth_time: now,
        iat: now,
        exp: now + 300,
      },
    ]
      .map((part) => Buffer.from(JSON.stringify(part)).toString("base64url"))
      .join(".");
    const signature = sign("sha256", Buffer.from(encoded), {
      key: this.keys.privateKey,
      dsaEncoding: "ieee-p1363",
    }).toString("base64url");
    return {
      token_type: "Bearer",
      id_token: `${encoded}.${signature}`,
      access_token: "independent-public-synthetic-access",
    };
  }
}
