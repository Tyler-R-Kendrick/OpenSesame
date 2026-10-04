import { afterEach, describe, expect, it } from "vitest";
import {
  CLIENT,
  closeServers,
  complete,
  fragment,
  pagesAnswer,
  relyingParty,
  start,
} from "./app.fixture.js";
import { issuerOf } from "./config.js";

afterEach(closeServers);

describe("the relying party app", () => {
  it("sends the person to Pages with a fresh state and nonce, and a binding cookie", async () => {
    const { config, base } = await relyingParty();
    const first = await start(base);
    const second = await start(base);
    expect(first.status).toBe(302);
    if (first.url === null) throw new Error("no redirect to Pages");
    const { url } = first;
    expect(`${url.origin}${url.pathname}`).toBe(issuerOf(config));
    expect(url.searchParams.get("client_id")).toBe(CLIENT);
    expect(url.searchParams.get("redirect_uri")).toBe(config.redirectUri);
    expect(url.searchParams.get("response_type")).toBe("id_token");
    expect(url.searchParams.get("response_mode")).toBe("fragment");
    expect(first.state).not.toBe(second.state);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.cookie).not.toBe(second.cookie);
  });

  it("hands each browser its binding as a __Host- HttpOnly SameSite=Lax cookie, and never tells Pages", async () => {
    const { base } = await relyingParty();
    const first = await start(base);
    const header = first.response.headers.get("set-cookie") ?? "";
    expect(header).toMatch(/^__Host-siop_binding=[A-Za-z0-9_-]{43,}; /);
    for (const attribute of [
      "Path=/",
      "HttpOnly",
      "Secure",
      "SameSite=Lax",
      "Max-Age=600",
    ]) {
      expect(header, attribute).toContain(attribute);
    }
    expect(header).not.toContain("Domain=");
    const value = first.cookie.split("=")[1] ?? "";
    expect(first.url?.href).not.toContain(value);
  });

  it("takes each person's application id per login, and expects exactly it", async () => {
    const { config, base } = await relyingParty();
    const mine = "local_22222222-2222-4222-8222-222222222222";
    const login = await start(base, `?client_id=${mine}`);
    expect(login.url?.searchParams.get("client_id")).toBe(mine);
    const { idToken } = await pagesAnswer({
      nonce: login.nonce,
      config,
      audience: mine,
    });
    const done = await complete(
      base,
      "/callback",
      fragment(idToken, login.state),
      login.cookie,
    );
    expect(done.body.session.audience).toBe(mine);
    for (const bad of ["not-an-id", "local_x", "https://evil.example"]) {
      const refused = await start(
        base,
        `?client_id=${encodeURIComponent(bad)}`,
      );
      expect(refused.status, bad).toBe(400);
      expect(await refused.response.json()).toEqual({
        error: "invalid_client_id",
      });
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
      login.cookie,
    );
    expect(done.status).toBe(200);
    expect(done.body.session).toEqual({
      subject,
      issuer: issuerOf(config),
      audience: CLIENT,
    });
    expect(JSON.stringify(done.body)).not.toContain(idToken);
    // The binding is spent with the login.
    expect(done.response.headers.get("set-cookie") ?? "").toContain(
      "Max-Age=0",
    );
  });

  it("completes a login started for a second registered callback", async () => {
    const { config, base } = await relyingParty();
    const login = await start(base, "?callback=/callback/mobile");
    expect(login.url?.searchParams.get("redirect_uri")).toBe(
      `${new URL(config.redirectUri).origin}/callback/mobile`,
    );
    const { idToken, subject } = await pagesAnswer({
      nonce: login.nonce,
      config,
    });
    const response = fragment(idToken, login.state);
    // The page the person actually lands on decides: the primary callback is
    // the wrong one for this login, and the login survives the mistake.
    const wrong = await complete(base, "/callback", response, login.cookie);
    expect(wrong.body).toEqual({ error: "redirect_mismatch" });
    const right = await complete(
      base,
      "/callback/mobile",
      response,
      login.cookie,
    );
    expect(right.status).toBe(200);
    expect(right.body.session.subject).toBe(subject);
  });

  it("refuses a callback that is not one of the registered ones", async () => {
    const { base } = await relyingParty();
    for (const callback of ["/elsewhere", "//evil.example/x", "/callback/"]) {
      const refused = await start(
        base,
        `?callback=${encodeURIComponent(callback)}`,
      );
      expect(refused.status, callback).toBe(400);
      expect(await refused.response.json()).toEqual({
        error: "invalid_callback",
      });
    }
  });

  it("checks a primary redirect_uri that carries a query against the request it received", async () => {
    // A registered redirect with a query is part of the address: the callback
    // page posts to path and query, and the server compares both.
    const withQuery = await relyingParty({
      SIOP_RP_REDIRECT_URI: "/callback?tenant=a",
    });
    const login = await start(withQuery.base);
    expect(login.url?.searchParams.get("redirect_uri")).toBe(
      withQuery.config.redirectUri,
    );
    const { idToken } = await pagesAnswer({
      nonce: login.nonce,
      config: withQuery.config,
    });
    const response = fragment(idToken, login.state);
    const stripped = await complete(
      withQuery.base,
      "/callback",
      response,
      login.cookie,
    );
    expect(stripped.body).toEqual({ error: "redirect_mismatch" });
    const kept = await complete(
      withQuery.base,
      "/callback?tenant=a",
      response,
      login.cookie,
    );
    expect(kept.status).toBe(200);
  });

  it("refuses the same response twice", async () => {
    const { config, base } = await relyingParty();
    const login = await start(base);
    const { idToken } = await pagesAnswer({ nonce: login.nonce, config });
    const response = fragment(idToken, login.state);
    expect(
      (await complete(base, "/callback", response, login.cookie)).status,
    ).toBe(200);
    const replay = await complete(base, "/callback", response, login.cookie);
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
          nonce.cookie,
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
          audience.cookie,
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
          stale.cookie,
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
      login.cookie,
    );
    expect(done.body).toEqual({ error: "signature_invalid" });
  });
});
