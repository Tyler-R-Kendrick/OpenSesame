/**
 * The steps and scenarios behind `verify-device-identity.mjs`: how a guest
 * reaches the Identity sheet, connects, walks Settings and Access, how a
 * member vault is locked and unlocked against the app's own device host, and
 * how a capability that arrives late is seen. Split from the script so each
 * half reads on its own and the structural ratchet stays met.
 */
import fs from "node:fs";
import path from "node:path";
import {
  awaitCapabilitySections,
  capabilityOffSwitch,
  capabilityOnSwitch,
} from "./always-on.mjs";
import { doorGuest, passTheDoor } from "./front-door.mjs";
import {
  lockVault,
  sealLocalOnly,
  unlockWithPin,
  waitOpen,
} from "./pages-journey.mjs";

const SIGN_OUT = "Also sign out of Identity when the vault locks";
const PRINCIPAL = /\bprn_[A-Za-z0-9_-]{43}\b/;
const ACCESS_TABS = [
  "grants",
  "requests",
  "sessions",
  "connectors",
  "resources",
  "policies",
];

export const WIDTHS = [
  {
    name: "desktop",
    size: { width: 1280, height: 900 },
    device: {},
    // The top bar, and with it the Identity sheet, is drawn below 901px.
    narrow: { width: 700, height: 900 },
  },
  {
    name: "phone",
    size: { width: 390, height: 844 },
    device: {
      viewport: { width: 390, height: 844 },
      hasTouch: true,
      isMobile: true,
      deviceScaleFactor: 3,
    },
    narrow: null,
  },
];

/** What one run of the harness gives the steps: set by `configureScenarios`. */
const env = {};

/** Give the steps the harness of this run (origin, base, dist, check, ...). */
export function configureScenarios(next) {
  Object.assign(env, next);
}

/** In-app navigation: the router's own history, so no reload ends the vault. */
export async function go(page, route) {
  await page.evaluate(
    ([base, to]) => {
      history.pushState({}, "", base + to.replace(/^\//, ""));
      window.dispatchEvent(new PopStateEvent("popstate"));
    },
    [env.BASE, route],
  );
  await page.waitForTimeout(900);
}

export async function signOutRowCount(page) {
  return page.getByRole("switch", { name: SIGN_OUT }).count();
}

export async function openGeneral(page) {
  await go(page, "/settings");
  await page
    .getByRole("switch", {
      name: "Lock when this tab goes to the background",
    })
    .waitFor({ timeout: 15000 });
}

/** Open the More sheet and read what the Identity tile says. */
async function identityTile(page) {
  await page
    .getByRole("button", { name: /^More —/ })
    .first()
    .click();
  const tile = page.locator(".conn", { hasText: "Identity" }).first();
  await tile.waitFor({ timeout: 10000 });
  return tile;
}

export async function connect(page, label) {
  const tile = await identityTile(page);
  const state = (await tile.locator(".conn__state").innerText()).trim();
  env.check(
    state === "This device",
    `${label}: the status reads "This device"`,
  );
  await env.snap(page, `${label}-more-before`, { fullPage: false });
  await tile.click();
  const sheet = page.getByRole("dialog", { name: "Identity connection" });
  await sheet.waitFor({ timeout: 10000 });
  env.check(
    /No session/.test(await sheet.innerText()),
    `${label}: the sheet starts with no session`,
  );
  // Use this device closes the sheet when the session is open.
  await sheet.getByRole("button", { name: "Use this device" }).click();
  await sheet.waitFor({ state: "detached", timeout: 15000 });
  await (await identityTile(page)).click();
  await sheet.getByText("Session active").waitFor({ timeout: 15000 });
  const first = PRINCIPAL.exec(await sheet.innerText())?.[0] ?? null;
  env.check(first !== null, `${label}: the principal is prn_ + a thumbprint`);
  await env.snap(page, `${label}-session`, { fullPage: false });
  await sheet.getByRole("button", { name: "Refresh session" }).click();
  await sheet.getByText("Session refreshed.").waitFor({ timeout: 15000 });
  const again = PRINCIPAL.exec(await sheet.innerText())?.[0] ?? null;
  env.check(
    first !== null && first === again,
    `${label}: Refresh keeps the same principal (it is the vault's key)`,
  );
  await sheet.getByRole("button", { name: "Close" }).first().click();
  await sheet.waitFor({ state: "detached", timeout: 10000 });
}

export async function chooseCapability(page, title) {
  await go(page, "/settings/capabilities");
  await awaitCapabilitySections(page);
  const on = capabilityOnSwitch(page, title);
  if ((await on.count()) === 1) return;
  const add = capabilityOffSwitch(page, title);
  await add.waitFor({ timeout: 15000 });
  await add.click();
  await page.getByTestId("capability-review").waitFor({
    state: "detached",
    timeout: 15000,
  });
  await capabilityOnSwitch(page, title).waitFor({ timeout: 15000 });
}

/** Turn an optional capability off when a walk needs the absent state first. */
export async function clearCapability(page, title) {
  await go(page, "/settings/capabilities");
  await awaitCapabilitySections(page);
  const off = capabilityOffSwitch(page, title);
  if ((await off.count()) === 1) return;
  const on = capabilityOnSwitch(page, title);
  await on.waitFor({ timeout: 15000 });
  await on.click();
  await capabilityOffSwitch(page, title).waitFor({ timeout: 15000 });
}

export async function walkAccess(page, label, { receipts }) {
  for (const tab of ACCESS_TABS) {
    await go(page, `/access?view=${tab}`);
    const text = await env.snap(page, `${label}-access-${tab}`);
    env.check(
      !/Something went wrong|Uncaught/i.test(text),
      `${label}: Access ${tab} rendered`,
    );
    if (tab === "sessions") {
      await go(page, "/access?view=sessions#access-receipts");
      const drawn =
        (await page.getByRole("tree", { name: "Receipts items" }).count()) > 0;
      env.check(
        drawn === receipts,
        `${label}: Receipts ${receipts ? "is" : "is not"} drawn on Sessions`,
      );
    }
  }
}

/**
 * The device host the app itself runs, imported by URL: the same module
 * instance, so its sessions and the vault it reads are the app's own. It is a
 * lazy chunk named for the module.
 */
const hostChunk = () =>
  fs
    .readdirSync(path.join(env.DIST, "assets"))
    .find((file) => /^device-identity-host-.*\.js$/.test(file));

export async function hostCall(page, route, init = {}) {
  return page.evaluate(
    async ([url, to, options]) => {
      const host = await import(url);
      const res = await host.deviceIdentityFetch(to, options);
      return { status: res.status, body: await res.json() };
    },
    [`${env.ORIGIN}${env.BASE}assets/${hostChunk()}`, route, init],
  );
}

export const mintInit = { method: "POST", body: "{}" };
export const asBearer = (token) => ({
  headers: { authorization: `Bearer ${token}` },
});

export async function memberVault(browser) {
  const label = "member";
  env.setStep(label);
  env.check(
    hostChunk() !== undefined,
    `${label}: the device host is its own chunk`,
  );
  const { page, context } = await env.newPage(browser);
  await page.goto(`${env.ORIGIN}${env.BASE}`, { waitUntil: "networkidle" });
  await passTheDoor(page);
  await sealLocalOnly(page);

  const first = await hostCall(page, "/v1/principals/provisional", mintInit);
  env.check(first.status === 201, `${label}: a member vault mints a session`);
  const member = first.body.principalId;
  env.check(
    /^prn_[A-Za-z0-9_-]{43}$/.test(member),
    `${label}: the principal is the vault key's thumbprint`,
  );
  const me = await hostCall(
    page,
    "/v1/principals/me",
    asBearer(first.body.accessToken),
  );
  env.check(
    me.status === 200 &&
      me.body.id === member &&
      me.body.state === "active" &&
      me.body.assurance === "provisional",
    `${label}: /me is the active, provisional member principal`,
  );

  await lockVault(page);
  const locked = await hostCall(
    page,
    "/v1/principals/me",
    asBearer(first.body.accessToken),
  );
  env.check(
    locked.status === 423 && locked.body.error === "locked",
    `${label}: locked, the bearer answers 423`,
  );
  const remint = await hostCall(page, "/v1/principals/provisional", mintInit);
  env.check(remint.status === 423, `${label}: locked, nothing is issued`);
  const claim = await hostCall(page, "/v1/claims", {
    method: "POST",
    ...asBearer(first.body.accessToken),
    body: JSON.stringify({ targetManifest: { kind: "drop" } }),
  });
  env.check(claim.status === 423, `${label}: locked, no claim is created`);

  await unlockWithPin(page);
  const again = await hostCall(
    page,
    "/v1/principals/me",
    asBearer(first.body.accessToken),
  );
  env.check(
    again.status === 200 && again.body.id === member,
    `${label}: unlocked, the same bearer is the same principal`,
  );
  const second = await hostCall(page, "/v1/principals/provisional", mintInit);
  env.check(
    second.body.principalId === member,
    `${label}: a new session after unlock is the same principal`,
  );

  // A guest beside the sealed vault: another tomb, another key.
  await lockVault(page);
  await page.getByRole("button", { name: "Skip to the guest vault" }).click();
  await waitOpen(page);
  const guest = await hostCall(page, "/v1/principals/provisional", mintInit);
  env.check(
    guest.status === 201 &&
      /^prn_[A-Za-z0-9_-]{43}$/.test(guest.body.principalId) &&
      guest.body.principalId !== member,
    `${label}: a guest beside the vault has its own principal`,
  );
  const guestMe = await hostCall(
    page,
    "/v1/principals/me",
    asBearer(guest.body.accessToken),
  );
  env.check(
    guestMe.body.state === "provisional" &&
      guestMe.body.assurance === "provisional",
    `${label}: the guest is provisional`,
  );
  const stray = await hostCall(
    page,
    "/v1/principals/me",
    asBearer(second.body.accessToken),
  );
  env.check(
    stray.status === 401,
    `${label}: the member's bearer does not speak for the guest vault`,
  );
  await context.close();
}

/** A capability that arrives after the panel drew is seen without navigating. */
export async function lateActivation(browser) {
  const label = "late";
  env.setStep(label);
  const { page, context } = await env.newPage(browser);
  await page.goto(`${env.ORIGIN}${env.BASE}`, { waitUntil: "networkidle" });
  await doorGuest(page).click();
  await waitOpen(page);
  await chooseCapability(page, "Access authority");
  await clearCapability(page, "Browser-local IAM");
  await page.reload({ waitUntil: "networkidle" });
  await waitOpen(page);
  await page.setViewportSize(WIDTHS[0].narrow);
  await connect(page, label);
  await page.setViewportSize(WIDTHS[0].size);
  // The local IAM chunk arrives late: the plan commits, the module follows.
  await page.route("**/assets/cap-identity.local-iam-*.js", async (route) => {
    await new Promise((resolve) => setTimeout(resolve, 6000));
    await route.fallback();
  });
  await go(page, "/settings/capabilities");
  await awaitCapabilitySections(page);
  const add = capabilityOffSwitch(page, "Browser-local IAM");
  await add.waitFor({ timeout: 15000 });
  await add.click();
  await capabilityOnSwitch(page, "Browser-local IAM").waitFor({
    timeout: 15000,
  });
  await go(page, "/access?view=sessions#access-receipts");
  const early = await page
    .getByRole("tree", { name: "Receipts items" })
    .count();
  await env.snap(page, `${label}-before-activation`);
  await page
    .getByRole("tree", { name: "Receipts items" })
    .waitFor({ state: "attached", timeout: 20000 })
    .catch(() => undefined);
  const late = await page.getByRole("tree", { name: "Receipts items" }).count();
  env.check(
    early === 0,
    `${label}: Receipts is not drawn while the capability is still arriving`,
  );
  env.check(
    late === 1,
    `${label}: Receipts appears once the capability activates, with no navigation`,
  );
  await context.close();
}
