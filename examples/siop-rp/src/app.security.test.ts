import { afterEach, describe, expect, it } from "vitest";
import {
  closeServers,
  complete,
  fragment,
  pagesAnswer,
  relyingParty,
  start,
} from "./app.fixture.js";

afterEach(closeServers);

describe("login CSRF and session fixation", () => {
  it("refuses a valid response that arrives without the browser's cookie", async () => {
    const { config, base } = await relyingParty();
    const login = await start(base);
    const { idToken } = await pagesAnswer({ nonce: login.nonce, config });
    const planted = await complete(
      base,
      "/callback",
      fragment(idToken, login.state),
      "",
    );
    expect(planted.status).toBe(401);
    expect(planted.body).toEqual({ error: "login_unknown" });
    // The person who really started it can still finish.
    const real = await complete(
      base,
      "/callback",
      fragment(idToken, login.state),
      login.cookie,
    );
    expect(real.status).toBe(200);
  });

  it("refuses a valid response under another browser's cookie", async () => {
    const { config, base } = await relyingParty();
    const victim = await start(base);
    const attacker = await start(base);
    const { idToken } = await pagesAnswer({ nonce: victim.nonce, config });
    const crossed = await complete(
      base,
      "/callback",
      fragment(idToken, victim.state),
      attacker.cookie,
    );
    expect(crossed.body).toEqual({ error: "login_unknown" });
    const real = await complete(
      base,
      "/callback",
      fragment(idToken, victim.state),
      victim.cookie,
    );
    expect(real.status).toBe(200);
  });

  it("does not let a forged #error without the cookie close a login", async () => {
    const { config, base } = await relyingParty();
    const login = await start(base);
    const forged = `#${new URLSearchParams({ error: "access_denied", state: login.state }).toString()}`;
    const refused = await complete(base, "/callback", forged, "");
    expect(refused.body).toEqual({ error: "login_unknown" });
    const { idToken } = await pagesAnswer({ nonce: login.nonce, config });
    const real = await complete(
      base,
      "/callback",
      fragment(idToken, login.state),
      login.cookie,
    );
    expect(real.status).toBe(200);
  });

  it("closes the login on an error the person's own browser delivers", async () => {
    const { base } = await relyingParty();
    const login = await start(base);
    const error = `#${new URLSearchParams({ error: "access_denied", state: login.state }).toString()}`;
    const denied = await complete(base, "/callback", error, login.cookie);
    expect(denied.body).toEqual({ error: "provider_error" });
    const again = await complete(base, "/callback", error, login.cookie);
    expect(again.body).toEqual({ error: "login_unknown" });
  });
});

describe("the page's own policy", () => {
  it("lets the sign-in form submit to this server and follow its redirect to Pages", async () => {
    const { base } = await relyingParty();
    const page = await fetch(`${base}/`);
    const csp = page.headers.get("content-security-policy") ?? "";
    expect(csp).toContain("form-action 'self' https://pages.example");
    expect(csp).not.toContain("form-action 'none'");
    expect(await page.text()).toContain('action="/auth/start"');
  });
});

describe("a flood of logins", () => {
  it("refuses new logins once the store is full instead of evicting a person's", async () => {
    const { config, base } = await relyingParty({
      SIOP_RP_MAX_PENDING_LOGINS: "2",
    });
    const first = await start(base);
    const second = await start(base);
    const refused = await start(base);
    expect(refused.status).toBe(503);
    expect(refused.response.headers.get("retry-after")).toBe("30");
    expect(await refused.response.json()).toEqual({ error: "busy" });
    // Nobody already waiting was pushed out.
    for (const login of [first, second]) {
      const { idToken } = await pagesAnswer({ nonce: login.nonce, config });
      const done = await complete(
        base,
        "/callback",
        fragment(idToken, login.state),
        login.cookie,
      );
      expect(done.status).toBe(200);
    }
    // Room again once they finish.
    expect((await start(base)).status).toBe(302);
  });

  it("limits how many logins one client starts per minute", async () => {
    let clock = 1_000_000;
    const { base } = await relyingParty(
      { SIOP_RP_STARTS_PER_MINUTE: "3" },
      { now: () => clock },
    );
    for (let index = 0; index < 3; index += 1) {
      expect((await start(base)).status).toBe(302);
    }
    const limited = await start(base);
    expect(limited.status).toBe(429);
    expect(limited.response.headers.get("retry-after")).toBe("60");
    expect(await limited.response.json()).toEqual({ error: "rate_limited" });
    clock += 61_000;
    expect((await start(base)).status).toBe(302);
  });
});
