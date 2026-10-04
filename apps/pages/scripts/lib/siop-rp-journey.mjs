/**
 * The example **Node relying party** (`examples/siop-rp`) signs in against the
 * built Pages app from another origin (ADR 0161): its own process on a
 * loopback port, reading the deployment's metadata at startup and verifying
 * every token itself. Each refusal is provoked through the real ceremony; the
 * Pages side of each (locked vault, unregistered redirect, no consent without
 * a person) is asserted beside it.
 *
 * The sign-in starts where a person starts it: the RP's own `<form>`, whose
 * `form-action` the RP's CSP must allow *and whose 302 to Pages it must allow
 * too*, because a browser checks a form's redirect target against the policy.
 * The binding cookie is the browser's own: set by the RP, accepted or refused
 * by Chromium, sent back by the page's own POST.
 */
import { expect } from "@playwright/test";
import {
  expiredToken,
  humanConsent,
  lockedVault,
  refusals,
  unregisteredRedirect,
} from "./siop-rp-refusals.mjs";
import { freePort, startRelyingParty } from "./siop-rp-server.mjs";
import {
  answer,
  bindingCookieOf,
  expectRefused,
  expectVerified,
  gotoAfterAbort,
  post,
  startLogin,
  startLoginElsewhere,
  watch,
} from "./siop-rp-steps.mjs";

const pass = (what) => console.log(`PASS ${what}`);

function rpEnvironment(env) {
  const { issuer, ids, rpUrl, rpPort } = env;
  return (extra = {}) => ({
    OPENSESAME_PAGES_BASE: issuer.replace(/\/identity\/siop$/, ""),
    SIOP_RP_CLIENT_ID: ids.appOneId,
    SIOP_RP_REDIRECT_URI: `${rpUrl}/callback`,
    SIOP_RP_LISTEN: `127.0.0.1:${rpPort}`,
    SIOP_RP_CALLBACK_PATHS: "/callback,/callback/mobile",
    SIOP_RP_DISCOVER: "1",
    SIOP_RP_METADATA_URL: `${env.metadataServer}/siop-metadata.json`,
    // The journey's own loopback servers: a person's deployment is https.
    SIOP_RP_ALLOW_LOOPBACK_HTTP: "1",
    // The metadata is served beside this journey, not at the issuer's origin.
    SIOP_RP_METADATA_MIRROR: "1",
    SIOP_RP_STARTS_PER_MINUTE: "1000",
    ...extra,
  });
}

/**
 * Discovery is read at startup, pinned to the issuer the operator configured,
 * and a document that does not check out stops the process. So does a setting
 * that would let a plaintext address through.
 */
async function discoveryRefusals(env, rpEnv) {
  const stops = async (what, extra) => {
    const rp = startRelyingParty(rpEnv(extra));
    expect(await rp.exited, what).not.toBe(0);
    return rp.output();
  };
  await stops("not json", {
    SIOP_RP_METADATA_URL: `${env.metadataServer}/index.html`,
  });
  await stops("another issuer", {
    OPENSESAME_PAGES_BASE: "https://evil.example/OpenSesame",
  });
  // Not the issuer's own origin, and the operator did not say it is a mirror.
  await stops("document from another origin", {
    SIOP_RP_METADATA_MIRROR: "",
  });
  // A loopback redirect over http is local development, and says so.
  await stops("plaintext loopback without the opt-in", {
    SIOP_RP_ALLOW_LOOPBACK_HTTP: "",
    SIOP_RP_DISCOVER: "",
  });
  pass(
    "rp startup: a page that is not the metadata, metadata for another issuer, a document from an origin the operator did not name, and loopback http without the opt-in each stop the relying party",
  );
}

/**
 * Sign in the way a person does: press the RP's own button. Chromium submits
 * the form, receives the RP's real 302 and its Set-Cookie, and checks that
 * redirect against the page's `form-action` before it leaves for Pages.
 */
async function submitForm(env, watched, { clientId } = {}) {
  const { page, context, rpUrl, issuer } = env;
  const violations = [];
  const onConsole = (message) => {
    if (/form-action|Content Security Policy/i.test(message.text()))
      violations.push(message.text());
  };
  page.on("console", onConsole);
  await page.goto(`${rpUrl}/`);
  if (clientId !== undefined) await page.locator("#client_id").fill(clientId);
  // The hop after the RP's 302 goes straight to the real network, past the
  // harness that stands in for Pages, so the browser's own request to Pages
  // fails there. That is the proof the policy let it go: a blocked redirect
  // never reaches the network, and says so.
  const left = new Promise((resolve) => {
    const seen = (request) => {
      if (!request.url().startsWith(`${issuer}?`)) return;
      page.off("requestfailed", seen);
      resolve(request);
    };
    page.on("requestfailed", seen);
  });
  await page.locator("#signin-form").click({ noWaitAfter: true });
  const request = await left;
  expect(request.failure()?.errorText ?? "").not.toMatch(/BLOCKED_BY_CSP/);
  expect(request.redirectedFrom()?.url()).toBe(
    `${rpUrl}/auth/start${clientId === undefined ? "?client_id=" : `?client_id=${clientId}`}`,
  );
  page.off("console", onConsole);
  expect(violations).toEqual([]);
  const cookie = await bindingCookieOf(context, rpUrl);
  expect(cookie).toMatchObject({
    name: "__Host-siop_binding",
    httpOnly: true,
    secure: true,
    sameSite: "Lax",
    path: "/",
  });
  expect(watched.asked.at(-1).origin).toBe(new URL(issuer).origin);
  // Carry on from where the harness can answer.
  await gotoAfterAbort(page, request.url());
  return cookie;
}

/**
 * The detector above has teeth. The same form, on a page whose policy lets it
 * submit to its own server (`form-action 'self'`) but does not name Pages,
 * reaches the RP, is answered with the RP's 302 and is then stopped by the
 * browser at the redirect: the allowance for Pages in the RP's real policy is
 * what lets the real form through.
 */
async function formPolicyControl(env) {
  const { page, rpUrl, issuer } = env;
  const messages = [];
  const listen = (message) => messages.push(message.text());
  page.on("console", listen);
  await page.route(`${rpUrl}/control`, (route) =>
    route.fulfill({
      status: 200,
      headers: {
        "content-type": "text/html",
        "content-security-policy": "default-src 'none'; form-action 'self'",
      },
      body: `<!doctype html><form action="${rpUrl}/auth/start"><button id="go" type="submit">go</button></form>`,
    }),
  );
  const toPages = [];
  const asked = (request) => {
    if (request.url().startsWith(`${issuer}?`)) toPages.push(request.url());
  };
  page.on("request", asked);
  await page.goto(`${rpUrl}/control`);
  await page.locator("#go").click({ noWaitAfter: true });
  await page.waitForTimeout(1000);
  page.off("console", listen);
  page.off("request", asked);
  await page.unroute(`${rpUrl}/control`);
  expect(messages.join("\n")).toMatch(/form-action/);
  // Stopped before the network: no request to Pages was ever made.
  expect(toPages).toEqual([]);
  expect(page.url()).toBe(`${rpUrl}/control`);
  pass(
    "rp form policy control: with form-action 'self' alone the browser stops the form at the RP's redirect to Pages, so the real policy's Pages origin is what lets the real form through",
  );
}

/** Allow, through the form: the Node RP verifies the browser's token itself. */
async function allow(env, watched) {
  const { page, issuer, ids, siopVerify, rpUrl } = env;
  await page.goto("about:blank");
  await submitForm(env, watched);
  await answer(page, ids.personName, rpUrl);
  const shown = await expectVerified(page);
  const verified = await siopVerify.verifySiopRedirect(
    watched.answered.at(-1),
    {
      issuer,
      clientId: ids.appOneId,
      nonce: watched.asked.at(-1).searchParams.get("nonce"),
    },
  );
  expect(shown).toEqual({
    subject: verified.sub,
    issuer,
    audience: ids.appOneId,
  });
  expect(await page.content()).not.toContain("id_token");
  expect(page.url()).toBe(`${rpUrl}/callback`);
  expect(await bindingCookieOf(env.context, rpUrl)).toBeNull();
  pass(
    "rp allow: the form's redirect passed the page's CSP, the browser kept the __Host- binding cookie and sent it back, and the Node relying party verified the token itself and agrees with an independent verifier",
  );
  return shown;
}

/** The same response again, and the same token on a new login. */
async function replays(env, watched) {
  const { rpUrl } = env;
  const response = new URL(watched.answered.at(-1)).hash;
  expect((await post(rpUrl, "/callback", response)).body).toEqual({
    error: "login_replayed",
  });
  const second = await startLoginElsewhere(rpUrl);
  const token = new URLSearchParams(response.slice(1)).get("id_token");
  const again = `#${new URLSearchParams({ id_token: token, state: second.state })}`;
  expect((await post(rpUrl, "/callback", again, second.cookie)).body).toEqual({
    error: "token_replayed",
  });
  pass(
    "rp replay: a response, and a token on a fresh login, are each refused the second time",
  );
}

/**
 * Another person's application id, handed to the same relying party per
 * login through the form's own field: it expects that audience, and the
 * subject is a different key.
 */
async function otherApplication(env, watched, first) {
  const { page, ids, rpUrl } = env;
  await page.goto("about:blank");
  await submitForm(env, watched, { clientId: ids.appTwoId });
  expect(new URL(page.url()).searchParams.get("client_id")).toBe(ids.appTwoId);
  await answer(page, ids.personName, rpUrl);
  const shown = await expectVerified(page);
  expect(shown.audience).toBe(ids.appTwoId);
  expect(shown.subject).not.toBe(first.subject);
  pass(
    "rp per-person application id: the same server verified a second application id for the same person, under a different pairwise subject",
  );
}

/** A second registered callback, chosen when the login starts, completes there. */
async function secondaryCallback(env) {
  const { page, context, ids, rpUrl } = env;
  const login = await startLogin(context, rpUrl, {
    callback: "/callback/mobile",
  });
  expect(login.url.searchParams.get("redirect_uri")).toBe(
    `${rpUrl}/callback/mobile`,
  );
  await page.goto(login.url.href);
  await answer(page, ids.personName, rpUrl);
  const shown = await expectVerified(page);
  expect(shown.audience).toBe(ids.appOneId);
  expect(page.url()).toBe(`${rpUrl}/callback/mobile`);
  const refused = await context.request.get(
    `${rpUrl}/auth/start?callback=/not-registered`,
    { maxRedirects: 0 },
  );
  expect(refused.status()).toBe(400);
  pass(
    "rp secondary callback: a login started for /callback/mobile completed at /callback/mobile, and a callback that is not registered is refused at start",
  );
}

/**
 * Login CSRF. A response to a login somebody else began, delivered to this
 * browser, is refused: this browser's binding is not that login's. With no
 * cookie at all it is refused the same way, and the login survives both.
 */
async function plantedResponses(env) {
  const { page, context, ids, rpUrl } = env;
  // The browser holds a binding of its own, for a login that is not the one
  // answered below.
  const mine = await startLogin(context, rpUrl);
  expect(mine.state).not.toBe("");

  const theirs = await startLoginElsewhere(rpUrl);
  await page.goto(theirs.url.href);
  await answer(page, ids.personName, rpUrl);
  await expectRefused(page, "login_unknown");
  pass(
    "rp login CSRF: a response to another browser's login is refused (login_unknown)",
  );

  await context.clearCookies();
  const bare = await startLoginElsewhere(rpUrl);
  await page.goto(bare.url.href);
  await answer(page, ids.personName, rpUrl);
  await expectRefused(page, "login_unknown");
  pass("rp login CSRF: the same with no cookie at all (login_unknown)");

  // Neither attempt used the logins up: their own browsers can still finish.
  const finished = await post(
    rpUrl,
    "/callback",
    `#${new URLSearchParams({ error: "access_denied", state: bare.state })}`,
    bare.cookie,
  );
  expect(finished.body).toEqual({ error: "provider_error" });
  pass(
    "rp login CSRF: a login a planted response was refused for is still the owner's to finish",
  );
}

/**
 * A second, real process with small limits: one client may not start more
 * logins than its allowance, and a store with no room refuses (503) rather
 * than push out a login somebody is in the middle of.
 */
async function floods(env, rpEnv) {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}`;
  const listen = {
    SIOP_RP_LISTEN: `127.0.0.1:${port}`,
    SIOP_RP_REDIRECT_URI: `${url}/callback`,
    SIOP_RP_DISCOVER: "",
  };
  const limited = startRelyingParty(
    rpEnv({ ...listen, SIOP_RP_STARTS_PER_MINUTE: "2" }),
  );
  await limited.ready;
  try {
    const statuses = [];
    for (let attempt = 0; attempt < 3; attempt += 1) {
      statuses.push(
        (await fetch(`${url}/auth/start`, { redirect: "manual" })).status,
      );
    }
    expect(statuses).toEqual([302, 302, 429]);
  } finally {
    await limited.stop();
  }
  const full = startRelyingParty(
    rpEnv({ ...listen, SIOP_RP_MAX_PENDING_LOGINS: "2" }),
  );
  await full.ready;
  try {
    const first = await startLoginElsewhere(url);
    const second = await startLoginElsewhere(url);
    const refused = await fetch(`${url}/auth/start`, { redirect: "manual" });
    expect(refused.status).toBe(503);
    expect(refused.headers.get("retry-after")).toBe("30");
    // Neither login in progress was pushed out to make room.
    for (const login of [first, second]) {
      const denied = `#${new URLSearchParams({ error: "access_denied", state: login.state })}`;
      expect((await post(url, "/callback", denied, login.cookie)).body).toEqual(
        { error: "provider_error" },
      );
    }
  } finally {
    await full.stop();
  }
  pass(
    "rp flood: a client over its allowance gets 429, and a full login store answers 503 without evicting a login in progress",
  );
}

/** Last: the expired token moves the browser's clock back two hours. */
export async function nodeRpJourney(env) {
  const rpEnv = rpEnvironment(env);
  await discoveryRefusals(env, rpEnv);
  await floods(env, rpEnv);
  const watched = watch(env.page, env.issuer, env.rpUrl);
  const rp = startRelyingParty(rpEnv());
  await rp.ready;
  try {
    await formPolicyControl(env);
    const first = await allow(env, watched);
    await replays(env, watched);
    await otherApplication(env, watched, first);
    await secondaryCallback(env);
    await plantedResponses(env);
    await refusals(env);
    await unregisteredRedirect(env);
    await humanConsent(env);
    await lockedVault(env);
    await expiredToken(env);
  } finally {
    await rp.stop();
  }
}
