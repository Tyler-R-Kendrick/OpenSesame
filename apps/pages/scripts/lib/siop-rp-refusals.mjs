/**
 * What the example Node relying party and Pages each refuse, provoked through
 * the real ceremony (ADR 0161): a damaged signature, a request wrong in one
 * field, an unregistered redirect, a locked vault, no consent without a person,
 * an expired token. Split from `siop-rp-journey.mjs` to stay under the module
 * size budget.
 */
import { expect } from "@playwright/test";
import {
  answer,
  expectRefused,
  relyingPartyTraffic,
  startLogin,
  tamperPostedSignature,
  unlockIfAsked,
} from "./siop-rp-steps.mjs";
import { expectInTray } from "./tray-contract.mjs";

const pass = (what) => console.log(`PASS ${what}`);

/** A response the browser really posts with a damaged signature, and requests wrong in one field. */
export async function refusals(env) {
  const { page, context, ids, rpUrl } = env;
  await tamperPostedSignature(page, rpUrl);
  const tampered = await startLogin(context, rpUrl);
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
    const login = await startLogin(context, rpUrl);
    login.url.searchParams.set(parameter, value);
    await page.goto(login.url.href);
    await answer(page, ids.personName, rpUrl);
    await expectRefused(page, code);
    pass(`rp wrong ${field}: refused (${code})`);
  }
}

/** Pages refuses to issue at all, and says nothing to the relying party. */
export async function unregisteredRedirect(env) {
  const { page, context, harness, origin, rpUrl } = env;
  const login = await startLogin(context, rpUrl);
  login.url.searchParams.set("redirect_uri", `${rpUrl}/not-registered`);
  const mark = harness.log.length;
  await page.goto(login.url.href);
  await unlockIfAsked(page);
  await expectInTray(page, /unavailable/i);
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
export async function humanConsent(env) {
  const { page, context, harness, origin, ids, rpUrl } = env;
  const login = await startLogin(context, rpUrl);
  const mark = harness.log.length;
  await page.goto(login.url.href);
  await unlockIfAsked(page);
  await expect(
    page.getByRole("heading", { name: /Self-issued sign-in to/ }),
  ).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: "Allow Self-Issued sign-in",
      exact: true,
    }),
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
export async function lockedVault(env) {
  const { page, context, harness, origin, base, rpUrl } = env;
  const login = await startLogin(context, rpUrl);
  await page.goto(`${origin}${base}vault`, { waitUntil: "networkidle" });
  await unlockIfAsked(page);
  await page
    .getByRole("button", { name: "Lock vault", exact: true })
    .filter({ visible: true })
    .click();
  const mark = harness.log.length;
  await page.goto(login.url.href);
  await expect(
    page.getByRole("button", { name: "Skip to the guest vault", exact: true }),
  ).toBeVisible();
  await page.waitForTimeout(1500);
  expect(new URL(page.url()).origin).toBe(origin);
  expect(relyingPartyTraffic(harness, mark)).toEqual([]);
  pass(
    "pages locked vault: the unlock screen, and no response ever reaches the relying party",
  );
}

/** The browser's clock two hours back: it mints a token already expired. */
export async function expiredToken(env) {
  const { page, context, ids, rpUrl } = env;
  await context.clock.setFixedTime(new Date(Date.now() - 2 * 3_600_000));
  const login = await startLogin(context, rpUrl);
  await page.goto(login.url.href);
  await answer(page, ids.personName, rpUrl);
  await expectRefused(page, "token_expired");
  pass("rp expired token: refused (token_expired)");
}
