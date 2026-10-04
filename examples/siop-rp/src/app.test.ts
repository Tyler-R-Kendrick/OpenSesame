import { type Server, createServer } from "node:http";
import type { AddressInfo } from "node:net";
import {
  buildSelfIssuedIdToken,
  ecP256JwkThumbprint,
  exportPublicEcP256Jwk,
} from "@opensesame/siop-v2";
import { generateKeyPair } from "jose";
import { afterEach, describe, expect, it } from "vitest";
import { createSiopRpApp } from "./app.js";
import { type SiopRpConfig, issuerOf, loadSiopRpConfig } from "./config.js";

const PAGES = "https://pages.example/OpenSesame";
const CLIENT = "local_00000000-0000-4000-8000-000000000001";

const open: Server[] = [];
afterEach(async () => {
  await Promise.all(
    open.splice(0).map(
      (server) =>
        new Promise<void>((done) => {
          server.close(() => done());
        }),
    ),
  );
});

async function freePort(): Promise<number> {
  const probe = createServer();
  await new Promise<void>((ready) => probe.listen(0, "127.0.0.1", ready));
  const address = probe.address();
  await new Promise<void>((done) => probe.close(() => done()));
  // SAFETY: the node:net Server contract returns an AddressInfo once listen(0, host) has completed, and this probe listens on 127.0.0.1.
  const { port } = address as AddressInfo;
  return port;
}

async function relyingParty(env: Record<string, string> = {}) {
  const port = await freePort();
  const config: SiopRpConfig = loadSiopRpConfig({
    OPENSESAME_PAGES_BASE: PAGES,
    SIOP_RP_CLIENT_ID: CLIENT,
    SIOP_RP_LISTEN: `127.0.0.1:${port}`,
    SIOP_RP_CALLBACK_PATHS: "/callback,/callback/mobile",
    ...env,
  });
  const server = createServer(createSiopRpApp(config));
  await new Promise<void>((ready) => server.listen(port, "127.0.0.1", ready));
  open.push(server);
  return { config, base: `http://127.0.0.1:${port}` };
}

/** Start a login the way a browser would, and read what Pages would be sent. */
async function start(base: string) {
  const response = await fetch(`${base}/auth/start`, { redirect: "manual" });
  const location = response.headers.get("location") ?? "";
  const url = new URL(location);
  return {
    status: response.status,
    url,
    state: url.searchParams.get("state") ?? "",
    nonce: url.searchParams.get("nonce") ?? "",
  };
}

type PagesAnswerInput = {
  nonce: string;
  config: SiopRpConfig;
  audience?: string;
  issuedAtSeconds?: number;
};

/** What Pages would sign for this login. */
async function pagesAnswer(input: PagesAnswerInput) {
  const { privateKey, publicKey } = await generateKeyPair("ES256", {
    extractable: true,
  });
  const publicJwk = await exportPublicEcP256Jwk(publicKey);
  const idToken = await buildSelfIssuedIdToken({
    profile: { kind: "dynamic", issuer: issuerOf(input.config) },
    audience: input.audience ?? input.config.clientId,
    nonce: input.nonce,
    publicJwk,
    signingKey: privateKey,
    nowSeconds: input.issuedAtSeconds ?? Math.floor(Date.now() / 1000),
  });
  return { idToken, subject: await ecP256JwkThumbprint(publicJwk) };
}

async function complete(base: string, path: string, response: string) {
  const answer = await fetch(`${base}${path}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ response }),
  });
  return { status: answer.status, body: await answer.json() };
}

const fragment = (idToken: string, state: string) =>
  `#${new URLSearchParams({ id_token: idToken, state }).toString()}`;

describe("the relying party app", () => {
  it("sends the person to Pages with a fresh state and nonce", async () => {
    const { config, base } = await relyingParty();
    const first = await start(base);
    const second = await start(base);
    expect(first.status).toBe(302);
    expect(`${first.url.origin}${first.url.pathname}`).toBe(issuerOf(config));
    expect(first.url.searchParams.get("client_id")).toBe(CLIENT);
    expect(first.url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(first.url.searchParams.get("response_type")).toBe("id_token");
    expect(first.url.searchParams.get("response_mode")).toBe("fragment");
    expect(first.state).not.toBe(second.state);
    expect(first.nonce).not.toBe(second.nonce);
  });

  it("takes each person's application id per login, and expects exactly it", async () => {
    const { config, base } = await relyingParty();
    const mine = "local_22222222-2222-4222-8222-222222222222";
    const response = await fetch(`${base}/auth/start?client_id=${mine}`, {
      redirect: "manual",
    });
    const url = new URL(response.headers.get("location") ?? "");
    expect(url.searchParams.get("client_id")).toBe(mine);
    const { idToken } = await pagesAnswer({
      nonce: url.searchParams.get("nonce") ?? "",
      config,
      audience: mine,
    });
    const done = await complete(
      base,
      "/callback",
      fragment(idToken, url.searchParams.get("state") ?? ""),
    );
    expect(done.body.session.audience).toBe(mine);
    for (const bad of ["not-an-id", "local_x", "https://evil.example"]) {
      const refused = await fetch(
        `${base}/auth/start?client_id=${encodeURIComponent(bad)}`,
        { redirect: "manual" },
      );
      expect(refused.status, bad).toBe(400);
      expect(await refused.json()).toEqual({ error: "invalid_client_id" });
    }
  });

  it("verifies a response, returns the proven subject, and never echoes the token", async () => {
    const { config, base } = await relyingParty();
    const login = await start(base);
    const { idToken, subject } = await pagesAnswer({
      nonce: login.nonce,
      config,
    });
    const done = await complete(
      base,
      "/callback",
      fragment(idToken, login.state),
    );
    expect(done.status).toBe(200);
    expect(done.body.session).toEqual({
      subject,
      issuer: issuerOf(config),
      audience: CLIENT,
    });
    expect(JSON.stringify(done.body)).not.toContain(idToken);
  });

  it("refuses the same response twice", async () => {
    const { config, base } = await relyingParty();
    const login = await start(base);
    const { idToken } = await pagesAnswer({ nonce: login.nonce, config });
    const response = fragment(idToken, login.state);
    expect((await complete(base, "/callback", response)).status).toBe(200);
    const replay = await complete(base, "/callback", response);
    expect(replay.status).toBe(401);
    expect(replay.body).toEqual({ error: "login_replayed" });
  });

  it("refuses a wrong nonce, a wrong audience and an expired token", async () => {
    const { config, base } = await relyingParty();
    const nonce = await start(base);
    const wrongNonce = await pagesAnswer({ nonce: "not-the-nonce", config });
    expect(
      (
        await complete(
          base,
          "/callback",
          fragment(wrongNonce.idToken, nonce.state),
        )
      ).body,
    ).toEqual({ error: "nonce_mismatch" });

    const audience = await start(base);
    const wrongAudience = await pagesAnswer({
      nonce: audience.nonce,
      config,
      audience: "local_11111111-1111-4111-8111-111111111111",
    });
    expect(
      (
        await complete(
          base,
          "/callback",
          fragment(wrongAudience.idToken, audience.state),
        )
      ).body,
    ).toEqual({ error: "audience_mismatch" });

    const stale = await start(base);
    const expired = await pagesAnswer({
      nonce: stale.nonce,
      config,
      issuedAtSeconds: Math.floor(Date.now() / 1000) - 7_200,
    });
    expect(
      (
        await complete(
          base,
          "/callback",
          fragment(expired.idToken, stale.state),
        )
      ).body.error,
    ).toMatch(/token_expired|token_not_fresh/);
  });

  it("refuses a tampered signature", async () => {
    const { config, base } = await relyingParty();
    const login = await start(base);
    const { idToken } = await pagesAnswer({ nonce: login.nonce, config });
    const flipped = `${idToken.slice(0, -4)}${idToken.endsWith("AAAA") ? "BBBB" : "AAAA"}`;
    const done = await complete(
      base,
      "/callback",
      fragment(flipped, login.state),
    );
    expect(done.body).toEqual({ error: "signature_invalid" });
  });

  it("refuses a response that arrives on another callback route", async () => {
    const { config, base } = await relyingParty();
    const login = await start(base);
    const { idToken } = await pagesAnswer({ nonce: login.nonce, config });
    const response = fragment(idToken, login.state);
    const wrongRoute = await complete(base, "/callback/mobile", response);
    expect(wrongRoute.body).toEqual({ error: "redirect_mismatch" });
    // The login stays open for the route it was started for.
    expect((await complete(base, "/callback", response)).status).toBe(200);
  });

  it("refuses an unknown state, an OP error and a malformed body", async () => {
    const { config, base } = await relyingParty();
    const { idToken } = await pagesAnswer({ nonce: "n", config });
    expect(
      (await complete(base, "/callback", fragment(idToken, "never-issued")))
        .body,
    ).toEqual({ error: "login_unknown" });
    const login = await start(base);
    expect(
      (
        await complete(
          base,
          "/callback",
          `#error=access_denied&state=${login.state}`,
        )
      ).body,
    ).toEqual({ error: "provider_error" });
    expect((await complete(base, "/callback", "")).status).toBe(400);
    expect((await complete(base, "/callback", "#junk=1")).body).toEqual({
      error: "malformed_request",
    });
    const notJson = await fetch(`${base}/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{broken",
    });
    expect(notJson.status).toBe(400);
    expect(await notJson.json()).toEqual({ error: "malformed_request" });
    const tooLarge = await fetch(`${base}/callback`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ response: "x".repeat(40_000) }),
    });
    expect(tooLarge.status).toBe(400);
  });

  it("serves the callback page with a CSP that allows no inline code", async () => {
    const { base } = await relyingParty();
    const page = await fetch(`${base}/callback`);
    const policy = page.headers.get("content-security-policy") ?? "";
    expect(policy).toContain("script-src 'self'");
    expect(policy).not.toContain("unsafe-inline");
    expect(page.headers.get("referrer-policy")).toBe("no-referrer");
    expect(page.headers.get("cache-control")).toBe("no-store");
    expect(page.headers.get("x-powered-by")).toBeNull();
    const html = await page.text();
    expect(html).toContain('src="/siop-callback.js"');
    expect(html).not.toMatch(/<script>[^<]/);
    const script = await (await fetch(`${base}/siop-callback.js`)).text();
    expect(script.indexOf("history.replaceState")).toBeLessThan(
      script.indexOf("fetch(location.pathname"),
    );
  });
});
