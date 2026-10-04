/**
 * The example **Node relying party** (`examples/siop-rp`) signs in against the
 * built Pages app from another origin (ADR 0161): its own process on a
 * loopback port, reading the deployment's metadata at startup and verifying
 * every token itself. Each refusal is provoked through the real ceremony; the
 * Pages side of each (locked vault, unregistered redirect, no consent without
 * a person) is asserted beside it.
 */
import { expect } from "@playwright/test";
import {
  answer,
  expectRefused,
  expectVerified,
  post,
  relyingPartyTraffic,
  startLogin,
  tamperPostedSignature,
  unlockIfAsked,
  watch,
} from "./siop-rp-steps.mjs";
import { startRelyingParty } from "./siop-rp-server.mjs";

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
    ...extra,
  });
}

/**
 * Discovery is read at startup, pinned to the issuer the operator configured,
 * and a document that does not check out stops the process.
 */
async function discoveryRefusals(env, rpEnv) {
  const notJson = startRelyingParty(
    rpEnv({ SIOP_RP_METADATA_URL: `${env.metadataServer}/index.html` }),
  );
  expect(await notJson.exited).not.toBe(0);
  const otherIssuer = startRelyingParty(
    rpEnv({ OPENSESAME_PAGES_BASE: "https://evil.example/OpenSesame" }),
  );
  expect(await otherIssuer.exited).not.toBe(0);
  pass(
    "rp discovery: a page that is not the metadata, and metadata for another issuer, both stop the relying party at startup",
  );
}

/**
 * Allow, through the relying party's own link. The browser would follow the
 * RP's one 302 itself, straight to the real host, past the harness that serves
 * Pages: so the click is answered for real, the redirect is read, and the
 * browser is sent where it points.
 */
async function allow(env, watched) {
  const { page, issuer, ids, siopVerify, rpUrl } = env;
  const redirected = new Promise((resolve) => {
    page.route(`${rpUrl}/auth/start`, async (route) => {
      const reply = await route.fetch({ maxRedirects: 0 });
      expect(reply.status()).toBe(302);
      resolve(reply.headers().location);
      await route.abort();
    });
  });
  await page.goto(`${rpUrl}/`);
  await page.locator("#signin").click();
  await page.goto(await redirected);
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
  await page.unroute(`${rpUrl}/auth/start`);
  expect(await page.content()).not.toContain("id_token");
  expect(page.url()).toBe(`${rpUrl}/callback`);
  pass(
    "rp allow: the Node relying party verified the browser's token itself and agrees with an independent verifier",
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
  const second = await startLogin(rpUrl);
  const token = new URLSearchParams(response.slice(1)).get("id_token");
  const again = `#${new URLSearchParams({ id_token: token, state: second.state })}`;
  expect((await post(rpUrl, "/callback", again)).body).toEqual({
    error: "token_replayed",
  });
  pass(
    "rp replay: a response, and a token on a fresh login, are each refused the second time",
  );
}

/**
 * Another person's application id, handed to the same relying party per
 * login: it expects that audience, and the subject is a different key.
 */
async function otherApplication(env, first) {
  const { page, ids, rpUrl } = env;
  const theirs = await startLogin(rpUrl, ids.appTwoId);
  expect(theirs.url.searchParams.get("client_id")).toBe(ids.appTwoId);
  await page.goto(theirs.url.href);
  await answer(page, ids.personName, rpUrl);
  const shown = await expectVerified(page);
  expect(shown.audience).toBe(ids.appTwoId);
  expect(shown.subject).not.toBe(first.subject);
  pass(
    "rp per-person application id: the same server verified a second application id for the same person, under a different pairwise subject",
  );
}

/** A response the browser really posts with a damaged signature, and requests wrong in one field. */
async function refusals(env) {
  const { page, ids, rpUrl } = env;
  await tamperPostedSignature(page, rpUrl);
  const tampered = await startLogin(rpUrl);
  await page.goto(tampered.url.href);
  await answer(page, ids.personName, rpUrl);
  await expectRefused(page, "signature_invalid");
  await page.unroute(`${rpUrl}/callback`);
  pass("rp tampered signature: refused (signature_invalid)");

  const wrong = [
    ["nonce", "nonce_mismatch", ["nonce", "attacker-chosen-nonce"]],
    ["audience", "audience_mismatch", ["client_id", ids.appTwoId]],
    [
      "redirect_uri",
      "redirect_mismatch",
      ["redirect_uri", `${rpUrl}/callback/mobile`],
    ],
  ];
  for (const [field, code, [parameter, value]] of wrong) {
    const login = await startLogin(rpUrl);
    login.url.searchParams.set(parameter, value);
    await page.goto(login.url.href);
    await answer(page, ids.personName, rpUrl);
    await expectRefused(page, code);
    pass(`rp wrong ${field}: refused (${code})`);
  }
}

/** Pages refuses to issue at all, and says nothing to the relying party. */
async function unregisteredRedirect(env) {
  const { page, harness, origin, rpUrl } = env;
  const login = await startLogin(rpUrl);
  login.url.searchParams.set("redirect_uri", `${rpUrl}/not-registered`);
  const mark = harness.log.length;
  await page.goto(login.url.href);
  await unlockIfAsked(page);
  await expect(page.getByRole("alert")).toContainText(/unavailable/i);
  await expect(
    page.getByRole("button", { name: "Verify with passkey", exact: true }),
  ).toHaveCount(0);
  expect(new URL(page.url()).origin).toBe(origin);
  expect(relyingPartyTraffic(harness, mark)).toEqual([]);
  pass(
    "pages unregistered redirect_uri: no consent, no token, no request to the relying party",
  );
}

/** No token without a person: nothing happens by itself, and Deny answers. */
async function humanConsent(env) {
  const { page, harness, origin, ids, rpUrl } = env;
  const login = await startLogin(rpUrl);
  const mark = harness.log.length;
  await page.goto(login.url.href);
  await unlockIfAsked(page);
  await expect(
    page.getByRole("heading", { name: /Self-issued sign-in to/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Allow Self-Issued sign-in", exact: true }),
  ).toHaveCount(0);
  await page.waitForTimeout(1500);
  expect(new URL(page.url()).origin).toBe(origin);
  expect(relyingPartyTraffic(harness, mark)).toEqual([]);
  await answer(page, ids.personName, rpUrl, "deny");
  await expectRefused(page, "provider_error");
  pass(
    "pages human consent: no Allow before a passkey, no token without a click, Deny reaches the relying party as access_denied",
  );
}

/** A locked vault issues nothing. */
async function lockedVault(env) {
  const { page, harness, origin, base, rpUrl } = env;
  const login = await startLogin(rpUrl);
  await page.goto(`${origin}${base}vault`, { waitUntil: "networkidle" });
  await unlockIfAsked(page);
  await page
    .getByRole("button", { name: "Lock vault", exact: true })
    .filter({ visible: true })
    .click();
  const mark = harness.log.length;
  await page.goto(login.url.href);
  await expect(
    page.getByRole("button", { name: "Continue as guest", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(1500);
  expect(new URL(page.url()).origin).toBe(origin);
  expect(relyingPartyTraffic(harness, mark)).toEqual([]);
  pass(
    "pages locked vault: the unlock screen, and no response ever reaches the relying party",
  );
}

/** The browser's clock two hours back: it mints a token already expired. */
async function expiredToken(env) {
  const { page, context, ids, rpUrl } = env;
  await context.clock.setFixedTime(new Date(Date.now() - 2 * 3_600_000));
  const login = await startLogin(rpUrl);
  await page.goto(login.url.href);
  await answer(page, ids.personName, rpUrl);
  await expectRefused(page, "token_expired");
  pass("rp expired token: refused (token_expired)");
}

/** Last: the expired token moves the browser's clock back two hours. */
export async function nodeRpJourney(env) {
  const rpEnv = rpEnvironment(env);
  await discoveryRefusals(env, rpEnv);
  const watched = watch(env.page, env.issuer, env.rpUrl);
  const rp = startRelyingParty(rpEnv());
  await rp.ready;
  try {
    const first = await allow(env, watched);
    await replays(env, watched);
    await otherApplication(env, first);
    await refusals(env);
    await unregisteredRedirect(env);
    await humanConsent(env);
    await lockedVault(env);
    await expiredToken(env);
  } finally {
    await rp.stop();
  }
}
