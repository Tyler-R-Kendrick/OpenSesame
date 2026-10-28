import { generateKeyPairSync, sign, verify } from "node:crypto";
import { publicAuthorityReply } from "./native-public-consent-authority.mjs";

const ISSUER = "https://api.cursor.com/v1/origin";
const TOKEN_BASE = `${ISSUER}/app/installations`;
const INSTALLATION_ID = "i_01browserproof";
const APP_ID = "app_01browserproof";
const b64url = (value) => Buffer.from(value).toString("base64url");
function jwt(key, header, claims) {
  const input = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  return `${input}.${b64url(sign(null, Buffer.from(input), key))}`;
}
function consentDocument(callback, receipt) {
  const target = new URL(callback);
  target.searchParams.set("installation_receipt", receipt);
  return `<!doctype html><html><head><title>Synthetic Origin installation</title></head><body><h1>Protocol test consent</h1><p>Synthetic Origin authority; no live account.</p><a href="${target.href.replaceAll("&", "&amp;")}">Approve protocol test consent</a></body></html>`;
}
function recordOriginCall(state, request, url, body = "") {
  state.calls.push({
    method: request.method(),
    url: url.href,
    body: body ? JSON.parse(body) : null,
  });
}

function routeOriginInstallation(
  context,
  harness,
  callback,
  state,
  secrets,
  receipt,
) {
  return context.route(
    "https://cursor.com/codebase/apps/install**",
    async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      recordOriginCall(state, request, url);
      state.installUrls.push(url.href);
      harness.check(
        url.searchParams.get("client_id") === APP_ID &&
          url.searchParams.get("redirect_uri") === callback &&
          url.searchParams.get("scope") === "repository:contents:read" &&
          Boolean(url.searchParams.get("state")) &&
          !url.searchParams.has("response_type") &&
          !url.searchParams.has("code_challenge") &&
          !url.searchParams.has("code_challenge_method"),
        "Origin installation uses app ID, scopes, registered callback and state without OAuth code or PKCE",
      );
      const now = Math.floor(Date.now() / 1000);
      const token = jwt(
        receipt.privateKey,
        {
          alg: "EdDSA",
          kid: "origin-browser-proof-key",
          typ: "origin-installation-receipt+jwt",
        },
        {
          iss: ISSUER,
          aud: APP_ID,
          sub: INSTALLATION_ID,
          namespace_id: "ns_01browserproof",
          iat: now,
          exp: now + 300,
          jti: `receipt_browser_${state.installUrls.length}`,
          state: url.searchParams.get("state"),
        },
      );
      secrets.push(token);
      return route.fulfill({
        contentType: "text/html",
        headers: { "access-control-allow-origin": "*" },
        body: consentDocument(callback, token),
      });
    },
  );
}

function originDiscoveryReply(route, url, receiptJwk) {
  if (url.href === `${ISSUER}/.well-known/openid-configuration`)
    return publicAuthorityReply(route, {
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/keys`,
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["EdDSA"],
    });
  if (url.href === `${ISSUER}/keys`)
    return publicAuthorityReply(route, { keys: [receiptJwk] });
  return null;
}

async function mintOriginToken(
  route,
  request,
  body,
  state,
  secrets,
  app,
  harness,
) {
  const appJwt = (await request.allHeaders()).authorization?.replace(
    /^Bearer /,
    "",
  );
  const [protectedHeader, payload, signature] = appJwt.split(".");
  const header = JSON.parse(Buffer.from(protectedHeader, "base64url"));
  const claims = JSON.parse(Buffer.from(payload, "base64url"));
  const signatureValid = verify(
    null,
    Buffer.from(`${protectedHeader}.${payload}`),
    app.publicKey,
    Buffer.from(signature, "base64url"),
  );
  state.appProofs.push({ header, claims, signatureValid });
  secrets.push(appJwt);
  harness.check(
    signatureValid &&
      header.alg === "EdDSA" &&
      header.kid === APP_ID &&
      header.typ === "JWT" &&
      claims.iss === APP_ID &&
      claims.aud === "origin-apps" &&
      claims.exp - claims.iat === 300,
    "Origin mint authenticates with the exact signed five-minute app JWT",
  );
  const parsed = JSON.parse(body);
  harness.check(
    parsed.scopes.join(" ") === "repository:contents:read" &&
      !("repositoryIds" in parsed),
    "Origin mint attenuates only to the selected installation scopes",
  );
  state.minted++;
  state.latestExpiry = Date.now() + state.tokenLifetime;
  const token = `oit_browser_proof_${state.minted}`;
  secrets.push(token);
  return publicAuthorityReply(route, {
    token,
    expiresAt: new Date(state.latestExpiry).toISOString(),
  });
}

async function originRateLimitReply(route, request, state, harness) {
  const authorization = (await request.allHeaders()).authorization;
  harness.check(
    authorization === `Bearer oit_browser_proof_${state.minted}`,
    "Origin rate-limit read uses the latest sealed installation token",
  );
  if (authorization !== `Bearer oit_browser_proof_${state.minted}`)
    return publicAuthorityReply(
      route,
      { code: 7, message: "unavailable", details: [] },
      401,
    );
  return publicAuthorityReply(route, {
    resources: {
      core: { limit: 6000, remaining: 5999, reset: 1785682800, used: 1 },
    },
  });
}

export async function routeNativeOriginAuthority(context, harness, callback) {
  const app = generateKeyPairSync("ed25519");
  const receipt = generateKeyPairSync("ed25519");
  const privateKey = app.privateKey.export({ type: "pkcs8", format: "pem" });
  const state = {
    calls: [],
    installUrls: [],
    appProofs: [],
    minted: 0,
    tokenLifetime: 60_000,
    latestExpiry: 0,
    expectedDocuments: new Set(),
    expectedResponses: new Map(),
  };
  const secrets = [privateKey];
  const receiptJwk = {
    ...receipt.publicKey.export({ format: "jwk" }),
    kid: "origin-browser-proof-key",
    alg: "EdDSA",
    use: "sig",
  };
  await routeOriginInstallation(
    context,
    harness,
    callback,
    state,
    secrets,
    receipt,
  );
  await context.route("https://api.cursor.com/v1/origin/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (request.method() === "OPTIONS")
      return publicAuthorityReply(route, null, 204);
    const body = request.postData() ?? "";
    recordOriginCall(state, request, url, body);
    const discovery = originDiscoveryReply(route, url, receiptJwk);
    if (discovery) return discovery;
    if (url.href === `${TOKEN_BASE}/${INSTALLATION_ID}/access_tokens`)
      return mintOriginToken(
        route,
        request,
        body,
        state,
        secrets,
        app,
        harness,
      );
    if (url.href === `${ISSUER}/rate_limit`)
      return originRateLimitReply(route, request, state, harness);
    return publicAuthorityReply(
      route,
      { code: 5, message: "not found", details: [] },
      404,
    );
  });
  return {
    state,
    privateKey,
    secrets,
    appId: APP_ID,
    installationId: INSTALLATION_ID,
  };
}
