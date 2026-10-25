/** Independent Google REST/RS256 oracle; no application modules or client SDK are imported. */
import assert from "node:assert/strict";
import { generateKeyPairSync, randomBytes, verify } from "node:crypto";

export const GOOGLE_WALLET_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const GOOGLE_WALLET_ISSUER = "3388000000022125777";
export const GOOGLE_WALLET_CLASS = `${GOOGLE_WALLET_ISSUER}.operator`;
export const GOOGLE_WALLET_CLASS_URL = `https://walletobjects.googleapis.com/walletobjects/v1/genericClass/${GOOGLE_WALLET_CLASS}`;
export const GOOGLE_WALLET_SAVE_PREFIX = "https://pay.google.com/gp/v/save/";
const EMAIL = "wallet@browser-fixture.iam.gserviceaccount.com";
const SCOPE = "https://www.googleapis.com/auth/wallet_object.issuer";

function claims(jwt, publicKey) {
  assert.ok(jwt.length > 0 && jwt.length <= 16384, "Bounded signed JWT");
  const parts = jwt.split(".");
  assert.equal(parts.length, 3, "Complete JWT envelope");
  assert.ok(parts.every((part) => /^[A-Za-z0-9_-]+$/.test(part)));
  const [header, payload, signature] = parts;
  assert.deepEqual(JSON.parse(Buffer.from(header, "base64url").toString()), {
    alg: "RS256",
    typ: "JWT",
  });
  assert.equal(
    verify(
      "RSA-SHA256",
      Buffer.from(`${header}.${payload}`),
      publicKey,
      Buffer.from(signature, "base64url"),
    ),
    true,
    "Independent RSA signature verification",
  );
  return JSON.parse(Buffer.from(payload, "base64url").toString());
}
function recent(value) {
  assert.ok(Number.isSafeInteger(value), "Integral JWT issue time");
  assert.ok(
    Math.abs(value - Math.floor(Date.now() / 1000)) <= 60,
    "JWT was minted by the current operation",
  );
}
class GoogleWalletProtocol {
  #keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
  #tokens = new Set();
  #saved = [];
  #assertions = 0;
  constructor(appOrigin) {
    this.appOrigin = appOrigin;
    this.account = JSON.stringify({
      type: "service_account",
      project_id: "browser-fixture",
      private_key_id: "browser-fixture-key",
      client_email: EMAIL,
      private_key: this.#keys.privateKey
        .export({ type: "pkcs8", format: "pem" })
        .toString(),
      token_uri: GOOGLE_WALLET_TOKEN_URL,
    });
  }
  issue(body) {
    const form = new URLSearchParams(body);
    assert.deepEqual([...form.keys()].sort(), ["assertion", "grant_type"]);
    assert.equal(
      form.get("grant_type"),
      "urn:ietf:params:oauth:grant-type:jwt-bearer",
    );
    const payload = claims(form.get("assertion") ?? "", this.#keys.publicKey);
    assert.deepEqual(Object.keys(payload).sort(), [
      "aud",
      "exp",
      "iat",
      "iss",
      "scope",
    ]);
    assert.equal(payload.iss, EMAIL);
    assert.equal(payload.aud, GOOGLE_WALLET_TOKEN_URL);
    assert.equal(payload.scope, SCOPE);
    recent(payload.iat);
    assert.equal(payload.exp, payload.iat + 3600);
    this.#assertions++;
    const access_token = randomBytes(32).toString("base64url");
    this.#tokens.add(access_token);
    return { access_token, expires_in: 3600, token_type: "Bearer" };
  }
  authorize(header) {
    assert.ok(this.#tokens.has(String(header ?? "").replace(/^Bearer /, "")));
    assert.ok(String(header).startsWith("Bearer "));
  }
  inspectSave(url) {
    assert.ok(url.startsWith(GOOGLE_WALLET_SAVE_PREFIX));
    assert.ok(url.length <= 4096, "Bounded public Save URL");
    const payload = claims(
      url.slice(GOOGLE_WALLET_SAVE_PREFIX.length),
      this.#keys.publicKey,
    );
    assert.deepEqual(Object.keys(payload).sort(), [
      "aud",
      "iat",
      "iss",
      "origins",
      "payload",
      "typ",
    ]);
    assert.equal(payload.iss, EMAIL);
    assert.equal(payload.aud, "google");
    assert.equal(payload.typ, "savetowallet");
    recent(payload.iat);
    assert.deepEqual(payload.origins, [this.appOrigin]);
    assert.deepEqual(Object.keys(payload.payload), ["genericObjects"]);
    const objects = payload.payload.genericObjects;
    assert.equal(objects.length, 1);
    assert.deepEqual(Object.keys(objects[0]).sort(), [
      "cardTitle",
      "classId",
      "header",
      "id",
      "state",
    ]);
    const object = objects[0];
    assert.match(
      object.id,
      new RegExp(`^${GOOGLE_WALLET_ISSUER}\\.os_[a-f0-9]{32}$`),
    );
    assert.equal(object.classId, GOOGLE_WALLET_CLASS);
    assert.equal(object.state, "ACTIVE");
    assert.deepEqual(Object.keys(object.cardTitle), ["defaultValue"]);
    assert.deepEqual(Object.keys(object.header), ["defaultValue"]);
    for (const field of [
      object.cardTitle.defaultValue,
      object.header.defaultValue,
    ]) {
      assert.deepEqual(Object.keys(field).sort(), ["language", "value"]);
      assert.equal(field.language, "en-US");
      assert.ok(field.value.length > 0 && field.value.length <= 120);
    }
    const wire = JSON.stringify(payload);
    assert.ok(!wire.includes("PRIVATE KEY"));
    assert.ok([...this.#tokens].every((token) => !wire.includes(token)));
    return payload;
  }
  save(url) {
    const payload = this.inspectSave(url);
    this.#saved.push(payload.payload.genericObjects[0].id);
    return payload;
  }
  snapshot() {
    return {
      assertions: this.#assertions,
      issuedTokens: this.#tokens.size,
      saved: [...this.#saved],
    };
  }
}
export function createGoogleWalletProtocol(appOrigin) {
  return new GoogleWalletProtocol(appOrigin);
}
