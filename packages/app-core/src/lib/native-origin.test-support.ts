import {
  type JWK,
  SignJWT,
  exportJWK,
  exportPKCS8,
  generateKeyPair,
  jwtVerify,
} from "jose";
import { vi } from "vitest";
import type { NativeDriverInput } from "./native-connector-drivers.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { bindNativeOAuthBrowserPort } from "./native-oauth-browser-port.js";
import {
  type NativeOriginOwner,
  ORIGIN_DISCOVERY_URL,
  ORIGIN_INSTALL_URL,
  ORIGIN_ISSUER,
  ORIGIN_JWKS_URL,
  ORIGIN_RATE_LIMIT_URL,
  ORIGIN_TOKEN_BASE,
} from "./native-origin-configuration.js";
import { createNativeOriginDriver } from "./native-origin-driver.js";
import { resetNativeOriginJwksCache } from "./native-origin-receipt.js";
import { runtimeFixture } from "./secret-backends/runtime.test-support.js";
import { vaultStore } from "./vault/store.js";

export const ORIGIN_TEST_APP_ID = "app_01synthetic";
export const ORIGIN_TEST_INSTALLATION = "i_01synthetic";
type OriginReceiptClaims = {
  aud?: string;
  iss?: string;
  state?: string;
  namespace_id?: string | null;
  iat?: number;
  exp?: number;
};
type OriginReceiptHeader = { typ?: string; kid?: string };
type OriginState = {
  calls: {
    method: string;
    url: string;
    body: string;
    authorization: string;
  }[];
  appJwts: string[];
  receipts: string[];
  installUrls: URL[];
  tokenLifetime: number;
  removed: boolean;
  installationId: string;
  minted: number;
  receiptClaims: OriginReceiptClaims;
  receiptHeader: OriginReceiptHeader;
  receiptSigningKey: CryptoKey;
  rateResponse: unknown;
};
function createOriginState(receiptSigningKey: CryptoKey): OriginState {
  return {
    calls: [],
    appJwts: [],
    receipts: [],
    installUrls: [],
    tokenLifetime: 60_000,
    removed: false,
    installationId: ORIGIN_TEST_INSTALLATION,
    minted: 0,
    receiptClaims: {},
    receiptHeader: {},
    receiptSigningKey,
    rateResponse: {
      resources: {
        core: { limit: 6000, remaining: 5999, reset: 1785682800, used: 1 },
      },
    },
  };
}

function authorizeOrigin(state: OriginState) {
  return async (href: string) => {
    const url = new URL(href);
    state.installUrls.push(url);
    const stateValue = url.searchParams.get("state") ?? "";
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({
      iss: ORIGIN_ISSUER,
      aud: ORIGIN_TEST_APP_ID,
      sub: state.installationId,
      namespace_id: "ns_01synthetic",
      jti: `receipt_${state.receipts.length + 1}`,
      state: stateValue,
      iat: now,
      exp: now + 300,
      ...state.receiptClaims,
    })
      .setProtectedHeader({
        alg: "EdDSA",
        kid: "origin-synthetic-key",
        typ: "origin-installation-receipt+jwt",
        ...state.receiptHeader,
      })
      .sign(state.receiptSigningKey);
    state.receipts.push(token);
    return new URLSearchParams({
      native_state: stateValue,
      native_code: token,
    }).toString();
  };
}

function originFetch(
  state: OriginState,
  app: Awaited<ReturnType<typeof generateKeyPair>>,
  publicJwk: JWK,
) {
  const json = <T>(body: T, status = 200) =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  return vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const body = request.method === "POST" ? await request.text() : "";
    const authorization = request.headers.get("authorization") ?? "";
    state.calls.push({
      method: request.method,
      url: request.url,
      body,
      authorization,
    });
    if (request.url === ORIGIN_DISCOVERY_URL)
      return json({
        issuer: ORIGIN_ISSUER,
        jwks_uri: ORIGIN_JWKS_URL,
        response_types_supported: ["id_token"],
        subject_types_supported: ["public"],
        id_token_signing_alg_values_supported: ["EdDSA"],
      });
    if (request.url === ORIGIN_JWKS_URL) return json({ keys: [publicJwk] });
    if (request.url === ORIGIN_RATE_LIMIT_URL) {
      if (
        state.removed ||
        authorization !== `Bearer oit_synthetic_${state.minted}`
      )
        return json({ code: 7, message: "unavailable", details: [] }, 401);
      return json(state.rateResponse);
    }
    if (
      request.url ===
      `${ORIGIN_TOKEN_BASE}/${state.installationId}/access_tokens`
    ) {
      const appJwt = authorization.replace(/^Bearer /, "");
      state.appJwts.push(appJwt);
      await jwtVerify(appJwt, app.publicKey, {
        issuer: ORIGIN_TEST_APP_ID,
        audience: "origin-apps",
        algorithms: ["EdDSA"],
        typ: "JWT",
      });
      if (state.removed)
        return json({ code: 5, message: "unavailable", details: [] }, 404);
      state.minted++;
      return json({
        token: `oit_synthetic_${state.minted}`,
        expiresAt: new Date(Date.now() + state.tokenLifetime).toISOString(),
      });
    }
    return json({ code: 5, message: "not found", details: [] }, 404);
  });
}

export async function originFixture() {
  resetNativeOriginJwksCache();
  const local = await runtimeFixture();
  const app = await generateKeyPair("Ed25519", { extractable: true });
  const receipt = await generateKeyPair("Ed25519", { extractable: true });
  const privateKey = await exportPKCS8(app.privateKey);
  const publicJwk = {
    ...(await exportJWK(receipt.publicKey)),
    kid: "origin-synthetic-key",
    alg: "EdDSA",
    use: "sig",
  };
  const state = createOriginState(receipt.privateKey);
  const fetch = originFetch(state, app, publicJwk);
  const transport: NativeProviderTransport = {
    fetch,
    settleCredentialMutation: fetch,
    assertCurrent: vi.fn(),
  };
  const owner: NativeOriginOwner = {
    tomb: vaultStore.getSnapshot().tomb,
    redirectUri: "https://selfhost.example/auth/native-connector.html",
    transport,
  };
  const closeBrowser = bindNativeOAuthBrowserPort({
    redirectUri: owner.redirectUri,
    navigate: vi.fn(),
    scrubCallback: vi.fn(),
    captureAuthorizationGuard: () => () => {},
    authorize: authorizeOrigin(state),
  });
  const driver = createNativeOriginDriver({
    capture: () => ({ ...owner, close: () => {} }),
  });
  const input: NativeDriverInput = {
    providerId: "origin",
    displayName: "Synthetic Origin",
    method: "oauth",
    parameters: {
      client_id: ORIGIN_TEST_APP_ID,
      redirect_uri: owner.redirectUri,
    },
    credentials: { private_key: privateKey },
    requestedScopes: { user: ["repository:contents:read"] },
    targetIds: {},
  };
  return {
    state,
    input,
    owner,
    driver,
    app,
    receipt,
    privateKey,
    publicJwk,
    fetch,
    async close() {
      closeBrowser();
      resetNativeOriginJwksCache();
      await local.close();
    },
  };
}
export function originInstallUrl() {
  return ORIGIN_INSTALL_URL;
}
