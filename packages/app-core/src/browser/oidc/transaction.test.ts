import { createHash, generateKeyPairSync, sign, webcrypto } from "node:crypto";
import type { BoundaryObject } from "@opensesame/os-domain";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { consumeNativeOidcProof } from "./claims.js";
import { type ConfiguredOidc, prepareConfiguredOidc } from "./transaction.js";

const keys = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = {
  ...keys.publicKey.export({ format: "jwk" }),
  kid: "independent",
  alg: "RS256",
};
const issuer = "https://idp.example.test/tenant";
const redirectUri = "https://pwa.example.test/app/auth/native-return";
function signed(payload: BoundaryObject, header: BoundaryObject = {}) {
  const content = [
    { alg: "RS256", kid: "independent", typ: "JWT", ...header },
    payload,
  ]
    .map((value) => Buffer.from(JSON.stringify(value)).toString("base64url"))
    .join(".");
  return `${content}.${sign("RSA-SHA256", Buffer.from(content), keys.privateKey).toString("base64url")}`;
}
function oracle(method = "client_secret_basic") {
  const stop = new AbortController();
  const transportStop = new AbortController();
  let current = true;
  let transportCurrent = true;
  let authorization: URL | null = null;
  let tokenCount = 0;
  const claims: BoundaryObject = {};
  const header: BoundaryObject = {};
  const discovery: BoundaryObject = {
    issuer,
    authorization_endpoint: `${issuer}/authorize`,
    token_endpoint: `${issuer}/token`,
    jwks_uri: `${issuer}/jwks`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: [method],
  };
  const config: ConfiguredOidc = {
    issuer,
    clientId: "client:with space",
    clientSecret: "public synthetic :secret café",
    scope: "openid profile",
    organization: {
      id: "org_original",
      authorizationParameter: "organization",
      claim: "org_id",
    },
  };
  const requests: {
    url: string;
    method: string;
    headers: Headers;
    body: string;
  }[] = [];
  let bodyHook: (() => void) | null = null;
  let tamper = false;
  const fetchImpl: typeof fetch = async (input, init) => {
    const url = String(input);
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: String(init?.body ?? ""),
    });
    expect(init).toMatchObject({
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
    let value: BoundaryObject;
    if (url === `${issuer}/.well-known/openid-configuration`) value = discovery;
    else if (url === `${issuer}/jwks`) value = { keys: [jwk] };
    else if (url === `${issuer}/token`) {
      tokenCount++;
      if (!authorization || tokenCount !== 1)
        throw new Error("Independent IdP refuses replay");
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("code")).toBe("independent-code");
      expect(body.get("redirect_uri")).toBe(redirectUri);
      expect(body.get("client_id")).toBe(config.clientId);
      expect(
        createHash("sha256")
          .update(body.get("code_verifier") ?? "")
          .digest("base64url"),
      ).toBe(authorization.searchParams.get("code_challenge"));
      const now = Math.floor(Date.now() / 1000);
      let token = signed(
        {
          iss: issuer,
          aud: config.clientId,
          sub: "independent-subject",
          iat: now,
          exp: now + 120,
          nonce: authorization.searchParams.get("nonce"),
          org_id: "org_original",
          name: "Synthetic Person",
          ...claims,
        },
        header,
      );
      if (tamper) {
        const parts = token.split(".");
        parts[2] = (parts[2].startsWith("A") ? "B" : "A") + parts[2].slice(1);
        token = parts.join(".");
      }
      value = { id_token: token };
    } else throw new Error("Independent IdP refuses unknown endpoint");
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    return new Response(
      new ReadableStream({
        pull(controller) {
          bodyHook?.();
          controller.enqueue(bytes);
          controller.close();
        },
      }),
    );
  };
  const owner = {
    signal: stop.signal,
    assertCurrent: () => {
      if (!current) throw new Error("Original owner retired");
    },
  };
  const transport = {
    signal: transportStop.signal,
    fetch: fetchImpl,
    assertCurrent: () => {
      if (!transportCurrent) throw new Error("Original transport retired");
    },
  };
  return {
    config,
    claims,
    header,
    discovery,
    requests,
    stop,
    transportStop,
    owner,
    transport,
    setBodyHook: (hook: () => void) => {
      bodyHook = hook;
    },
    retireOwner: () => {
      current = false;
    },
    retireTransport: () => {
      transportCurrent = false;
    },
    tamper: () => {
      tamper = true;
    },
    async prepare(input = config) {
      const attempt = await prepareConfiguredOidc(
        input,
        redirectUri,
        transport,
        owner,
      );
      authorization = new URL(attempt.authorizationUrl);
      return attempt;
    },
  };
}
beforeEach(() => vi.stubGlobal("crypto", webcrypto));
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
const answer = (state: string) => ({
  state,
  code: "independent-code",
  error: false,
});

describe("native configured confidential and organization OIDC", () => {
  it.each(["client_secret_basic", "client_secret_post"])(
    "exchanges with advertised %s and consumes genuine organization evidence once",
    async (method) => {
      const idp = oracle(method);
      const attempt = await idp.prepare();
      const url = new URL(attempt.authorizationUrl);
      expect(url.searchParams.get("organization")).toBe("org_original");
      expect(url.searchParams.get("code_challenge_method")).toBe("S256");
      expect(url.searchParams.has("client_secret")).toBe(false);
      expect(attempt.authorizationUrl).not.toContain(idp.config.clientSecret);
      const proof = await attempt.complete(answer(attempt.state));
      const tokenRequest = idp.requests.find(
        (request) => request.method === "POST",
      );
      expect(tokenRequest).toBeTruthy();
      const secret = new URLSearchParams(tokenRequest?.body).get(
        "client_secret",
      );
      const basic = tokenRequest?.headers.get("authorization");
      if (method === "client_secret_basic") {
        expect(secret).toBeNull();
        expect(Buffer.from(basic?.slice(6) ?? "", "base64").toString()).toBe(
          "client%3Awith+space:public+synthetic+%3Asecret+caf%C3%A9",
        );
      } else {
        expect(secret).toBe(idp.config.clientSecret);
        expect(basic).toBeNull();
      }
      const result = consumeNativeOidcProof(proof);
      expect(result.claims).toMatchObject({
        issuer,
        audience: idp.config.clientId,
        subject: "independent-subject",
        organizationId: "org_original",
        name: "Synthetic Person",
      });
      expect(Object.isFrozen(result.claims)).toBe(true);
      expect(() => consumeNativeOidcProof(proof)).toThrow(/already consumed/);
      await expect(attempt.complete(answer(attempt.state))).rejects.toThrow(
        /already consumed/,
      );
    },
  );
  it("supports organization-specific public clients without inventing a secret", async () => {
    const idp = oracle("none");
    const attempt = await idp.prepare({ ...idp.config, clientSecret: "" });
    consumeNativeOidcProof(await attempt.complete(answer(attempt.state)));
    const request = idp.requests.find((request) => request.method === "POST");
    expect(request?.headers.has("authorization")).toBe(false);
    expect(new URLSearchParams(request?.body).has("client_secret")).toBe(false);
  });
  it("uses configured organization parameter and exact signed claim names", async () => {
    const idp = oracle();
    idp.claims.tenant = "tenant_exact";
    const attempt = await idp.prepare({
      ...idp.config,
      organization: {
        id: "tenant_exact",
        authorizationParameter: "organization_id",
        claim: "tenant",
      },
    });
    expect(
      new URL(attempt.authorizationUrl).searchParams.get("organization_id"),
    ).toBe("tenant_exact");
    expect(
      consumeNativeOidcProof(await attempt.complete(answer(attempt.state)))
        .claims.organizationId,
    ).toBe("tenant_exact");
  });
  it.each([
    { org_id: "org_foreign" },
    { org_id: ["org_original"] },
    { org_id: null },
    { nonce: "foreign-nonce" },
    { iss: "https://foreign.example" },
    { aud: "foreign-client" },
    { aud: ["client:with space", "other"], azp: "other" },
    { exp: 1 },
    { sub: "" },
    { iat: Math.floor(Date.now() / 1000) + 3600 },
  ])("refuses independently signed mismatched claims %j", async (claims) => {
    const idp = oracle();
    Object.assign(idp.claims, claims);
    const attempt = await idp.prepare();
    await expect(attempt.complete(answer(attempt.state))).rejects.toThrow();
  });
  it.each([{ typ: "access_token" }, { jku: "https://attacker.example/jwks" }])(
    "refuses independently signed unsafe header %j",
    async (header) => {
      const idp = oracle();
      Object.assign(idp.header, header);
      const attempt = await idp.prepare();
      await expect(attempt.complete(answer(attempt.state))).rejects.toThrow();
    },
  );
  it("rejects an actually tampered RSA signature", async () => {
    const idp = oracle();
    idp.tamper();
    const attempt = await idp.prepare();
    await expect(attempt.complete(answer(attempt.state))).rejects.toThrow();
  });
  it.each(["state", "error", "empty-code"])(
    "burns a %s response before spending a secret",
    async (mode) => {
      const idp = oracle();
      const attempt = await idp.prepare();
      const response =
        mode === "state"
          ? { ...answer(attempt.state), state: "foreign" }
          : mode === "error"
            ? { ...answer(attempt.state), error: true }
            : { ...answer(attempt.state), code: null };
      await expect(attempt.complete(response)).rejects.toThrow(
        /original request/,
      );
      expect(idp.requests).toHaveLength(1);
      await expect(attempt.complete(answer(attempt.state))).rejects.toThrow(
        /already consumed/,
      );
    },
  );
  it.each(["issuer", "token_endpoint", "jwks_uri", "authorization_endpoint"])(
    "refuses unapproved or insecure discovery %s before token exchange",
    async (field) => {
      const idp = oracle();
      idp.discovery[field] =
        field === "authorization_endpoint"
          ? "http://attacker.example/endpoint"
          : "https://attacker.example/endpoint";
      await expect(idp.prepare()).rejects.toThrow();
      expect(idp.requests).toHaveLength(1);
    },
  );
  it("requires exact issuer bytes including trailing slash", async () => {
    const idp = oracle();
    idp.discovery.issuer = `${issuer}/`;
    await expect(idp.prepare()).rejects.toThrow(/exactly match/);
  });
  it.each(["private_key_jwt", "client_secret_jwt"])(
    "does not silently substitute auth method %s",
    async (method) => {
      const idp = oracle(method);
      await expect(idp.prepare()).rejects.toThrow(/authentication method/);
    },
  );
  it.each(["state", "client_id", "request_uri", "nonce"])(
    "refuses reserved organization parameter %s before networking",
    async (authorizationParameter) => {
      const idp = oracle();
      await expect(
        idp.prepare({
          ...idp.config,
          organization: {
            id: "org_original",
            authorizationParameter,
            claim: "org_id",
          },
        }),
      ).rejects.toThrow(/organization binding/);
      expect(idp.requests).toHaveLength(0);
    },
  );
  it("refuses expired original transactions before token exchange", async () => {
    const idp = oracle();
    const attempt = await idp.prepare();
    vi.useFakeTimers();
    vi.setSystemTime(attempt.expiresAt);
    await expect(attempt.complete(answer(attempt.state))).rejects.toThrow(
      /original request/,
    );
    expect(idp.requests).toHaveLength(1);
  });
  it.each(["owner", "transport"])(
    "refuses original %s retirement while discovery bytes stream",
    async (target) => {
      const idp = oracle();
      idp.setBodyHook(
        target === "owner" ? idp.retireOwner : idp.retireTransport,
      );
      await expect(idp.prepare()).rejects.toThrow(/retired/);
    },
  );
  it.each(["owner", "transport"])(
    "refuses original %s retirement before proof consumption and burns evidence",
    async (target) => {
      const idp = oracle();
      const attempt = await idp.prepare();
      const proof = await attempt.complete(answer(attempt.state));
      (target === "owner" ? idp.retireOwner : idp.retireTransport)();
      expect(() => consumeNativeOidcProof(proof)).toThrow(/retired/);
      expect(() => consumeNativeOidcProof(proof)).toThrow(/already consumed/);
    },
  );
  it.each(["owner", "transport"])(
    "honors the original %s abort signal before network",
    async (target) => {
      const idp = oracle();
      (target === "owner" ? idp.stop : idp.transportStop).abort();
      await expect(idp.prepare()).rejects.toThrow();
      expect(idp.requests).toHaveLength(0);
    },
  );
});

it("original transaction deadline also expires independently signed unconsumed evidence", async () => {
  const idp = oracle();
  idp.claims.exp = Math.floor(Date.now() / 1000) + 3600;
  const attempt = await idp.prepare();
  const proof = await attempt.complete(answer(attempt.state));
  const clock = vi.spyOn(Date, "now").mockReturnValue(attempt.expiresAt + 1);
  try {
    expect(() => consumeNativeOidcProof(proof)).toThrow(/expired/);
  } finally {
    clock.mockRestore();
  }
});
