/**
 * The walk behind `verify-device-inbox.mjs` (ADR 0162): a vault with no Identity
 * API and no Host, a request raised and waiting, the person told in another
 * tab, the decision made with the keyboard and the passkey, and the receipts
 * that decision leaves, at one width.
 *
 * Two tabs of one origin do the work: the person's, in front, and a second
 * that is in the background. A headless tab is never hidden, so the second is
 * told it is (`document.hidden` reads true there) and its `Notification` is
 * recorded rather than shown; both are stated here because they are the one
 * thing the harness stands in for.
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "@playwright/test";
import { unlockVault } from "./choose-capabilities.mjs";
import { lockVault } from "./pages-journey.mjs";

const ORIGIN = "https://tyler-r-kendrick.github.io";
const BASE = `${ORIGIN}/OpenSesame`;
const DIST = fileURLToPath(new URL("../../dist", import.meta.url));

export const INBOX_CAPABILITIES = [
  "Access authority",
  "Browser-local IAM",
  "Local notifications",
];

const REASON = "Browser request approval proof";

/** The person's own words for each decision, as Receipts says them. */
const RAISED = "Request raised · Test application";
const APPROVED = "Request approved · Test application";
const DENIED = "Request denied · Test application";
const WITHDRAWN = "Request withdrawn · Test application";
const SIGNED_IN = "Application signed in · Test application";
const ENDED = "Application sign-in ended · Test application";
const REFUSED = "Application sign-in refused · Test application";

const hostChunk = () =>
  fs
    .readdirSync(path.join(DIST, "assets"))
    .find((file) => /^device-identity-host-.*\.js$/.test(file));

/** The device host the app itself runs, imported by URL: one module instance. */
async function planeCall(page, route, init = {}) {
  return page.evaluate(
    async ([url, to, options]) => {
      const host = await import(url);
      const res = await host.deviceIdentityFetch(to, options);
      return { status: res.status, body: await res.json() };
    },
    [`${BASE}/assets/${hostChunk()}`, route, init],
  );
}

/** Keyboard activation: focus the control, then press Enter. */
export async function press(page, locator) {
  // A key that is not enabled yet takes the Enter and does nothing with it.
  await expect(locator).toBeEnabled({ timeout: 30_000 });
  await locator.focus();
  await page.keyboard.press("Enter");
}

export async function openTab(
  context,
  width,
  view,
  { background = false } = {},
) {
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    throw error;
  });
  if (background) {
    // Recorded, not shown; and a tab nobody is looking at.
    await page.addInitScript(() => {
      Object.defineProperty(document, "hidden", {
        configurable: true,
        get: () => true,
      });
      Object.defineProperty(document, "visibilityState", {
        configurable: true,
        get: () => "hidden",
      });
      const Real = globalThis.Notification;
      globalThis.__notified = [];
      globalThis.Notification = class extends Real {
        constructor(title, options) {
          super(title, options);
          globalThis.__notified.push({
            title,
            body: options?.body,
            tag: options?.tag,
            data: options?.data,
          });
        }
      };
    });
  }
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${BASE}/access?view=${view}`);
  await unlockVault(page);
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0, {
    timeout: 30_000,
  });
  return page;
}

export const notified = (page) =>
  page.evaluate(() => globalThis.__notified ?? []);

/** What the bell says in this layout: the bar's key, or the phone's More. */
export function bell(page, width) {
  return width < 900
    ? page.locator(".topbar__more.is-attn")
    : page.locator(".cx__btn--attn");
}

export async function raiseRequest(main, panel, reason) {
  const create = panel.getByRole("button", {
    name: "New local request",
    exact: true,
  });
  await press(main, create);
  await expect(panel.getByLabel("Requesting identity")).toBeFocused();
  const signIn = panel.getByRole("button", {
    name: "Sign in locally",
    exact: true,
  });
  if (await signIn.count()) await press(main, signIn);
  await expect(panel.getByLabel("Local session status")).toHaveText(
    /Signed in locally with a passkey/,
    { timeout: 30_000 },
  );
  await panel.getByLabel("Reason", { exact: true }).fill(reason);
  await press(
    main,
    panel.getByRole("button", { name: "Create local request", exact: true }),
  );
  await expect(
    panel.getByText("Local request created. No access was granted."),
  ).toBeVisible({ timeout: 30_000 });
}

async function receipts(main, width) {
  const tab = main.getByRole("tab", { name: /^Sessions/ });
  await press(main, tab);
  const list = main.locator("#access-receipts");
  await expect(list).toBeVisible({ timeout: 30_000 });
  expect(
    await main.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    `${width}px: Receipts do not scroll the page sideways`,
  ).toBe(false);
  return list;
}

/** The locked device shows nothing and answers 423 at the plane. */
async function lockedDevice(context, width) {
  const page = await context.newPage();
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${BASE}/access?view=sessions`);
  await expect(page.getByLabel("Password", { exact: true })).toBeVisible();
  const text = await page.locator("body").innerText();
  expect(text).not.toMatch(/Receipts|Local requests|waiting|Test application/i);
  expect(await page.title()).not.toMatch(/^\(\d+\)/);
  for (const route of ["/v1/audit/events", "/v1/authorization-requests"]) {
    const answer = await planeCall(page, route, {
      headers: { authorization: "Bearer not-a-session" },
    });
    expect(answer.status, `${route} while locked`).toBe(423);
    expect(answer.body.error).toBe("locked");
  }
  await page.close();
}

/** Tab to a key with the keyboard's own road, then activate it. */
export async function tabAndEnter(page, key) {
  for (let step = 0; step < 12; step++) {
    if (await key.evaluate((node) => node === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  await expect(key).toBeFocused();
  await page.keyboard.press("Enter");
}

/** B. A request is raised in front; the background tab is told, and says only that. */
async function raisedAndTold(t) {
  const { main, background, panel, width } = t;
  await expect(main.getByRole("img", { name: /waiting/ })).toHaveCount(0);
  await expect(bell(background, width)).toHaveCount(0);
  await raiseRequest(main, panel, REASON);
  await expect(
    main.getByRole("img", { name: "1 request waiting" }),
  ).toBeVisible();
  await expect
    .poll(() => background.title(), { timeout: 15_000 })
    .toMatch(/^\(1\) /);
  await expect(bell(background, width)).toHaveCount(1);
  await expect.poll(async () => (await notified(background)).length).toBe(1);
  const [ring] = await notified(background);
  expect(ring.title).toBe("Request waiting");
  expect(ring.body).toBe("A request is waiting for you.");
  expect(Object.keys(ring.data ?? {}).sort()).toEqual([
    "action",
    "kind",
    "ref",
  ]);
  expect(JSON.stringify(ring)).not.toMatch(
    /Test application|records:read|rp\.example|Browser request|openid/,
  );
  expect(await notified(main), "the tab in front rings no doorbell").toEqual(
    [],
  );
  // The bell opens onto the list, with a key and not a sentence to follow.
  await bell(background, width).first().click();
  // A phone has no strip: its bell is a row of the More sheet.
  if (width < 900)
    await background.getByRole("button", { name: /^Notifications/ }).click();
  await background.getByRole("button", { name: "Review requests" }).click();
  await expect(background).toHaveURL(/view=requests/);
}

/** C. Approved with the keyboard and the passkey: the marks go, a receipt stays. */
async function approvedAndReceipted(t) {
  const { main, background, panel, width } = t;
  await press(
    main,
    panel.getByRole("button", { name: "Review request", exact: true }).first(),
  );
  await expect(panel.getByLabel("Approving person")).toBeFocused();
  await tabAndEnter(
    main,
    panel.getByRole("button", { name: "Approve with passkey", exact: true }),
  );
  await expect(
    panel.getByText(
      "Request approved; awaiting single-use consumption by its requester.",
    ),
  ).toBeVisible();
  await expect(main.getByRole("img", { name: /waiting/ })).toHaveCount(0);
  await expect.poll(() => background.title()).not.toMatch(/^\(\d+\)/);
  await expect(bell(background, width)).toHaveCount(0);
  const list = await receipts(main, width);
  await expect(list).toContainText(APPROVED);
  await expect(list).toContainText(RAISED);
}

/** D. Withdrawn, then a second request refused with the keyboard. */
async function withdrawnAndDenied(t) {
  const { main, background, panel, width } = t;
  await press(main, main.getByRole("tab", { name: /^Requests/ }));
  await press(
    main,
    panel.getByRole("button", { name: "Review request", exact: true }).first(),
  );
  await press(main, panel.getByRole("button", { name: "Withdraw request" }));
  await press(main, panel.getByRole("button", { name: "Confirm withdrawal" }));
  await expect(panel.getByText("Request withdrawn.")).toBeVisible();
  await raiseRequest(main, panel, "Deny this request");
  await expect.poll(async () => (await notified(background)).length).toBe(2);
  await press(
    main,
    panel
      .getByRole("listitem")
      .filter({ hasText: "Deny this request" })
      .getByRole("button", { name: "Review request", exact: true }),
  );
  await expect(panel.getByLabel("Approving person")).toBeFocused();
  await tabAndEnter(
    main,
    panel.getByRole("button", { name: "Deny with passkey" }),
  );
  await expect(
    panel.getByText("Request denied.", { exact: true }),
  ).toBeVisible();
  const list = await receipts(main, width);
  await expect(list).toContainText(WITHDRAWN);
  await expect(list).toContainText(DENIED);
  await expect(list.getByRole("img", { name: "denied" }).first()).toBeVisible();
}

/** E. An application signs in through its own window, ends it, and is refused. */
async function applicationSignIn(t) {
  const { main, rp, context, mainDevice, rig, width } = t;
  const list = main.locator("#access-receipts");
  // The passkey has been used in the front tab: its signature counter has moved
  // on, and a popup that began from the seeded credential would be a replay.
  const used = await mainDevice.cdp.send("WebAuthn.getCredentials", {
    authenticatorId: mainDevice.authenticatorId,
  });
  const first = await rig.openConsent(rp, context, used.credentials, width);
  await rig.approveConsent(rp, first.popup, width);
  await expect(rp.locator("output")).toHaveText(/^Signed in locally: local_/, {
    timeout: 30_000,
  });
  await expect(list).toContainText(SIGNED_IN, { timeout: 30_000 });
  const fresh = await first.device.cdp.send("WebAuthn.getCredentials", {
    authenticatorId: first.device.authenticatorId,
  });
  await press(rp, rp.getByRole("button", { name: "Revoke", exact: true }));
  await expect(rp.locator("output")).toHaveText("Revoked", { timeout: 30_000 });
  await expect(list).toContainText(ENDED, { timeout: 30_000 });
  const second = await rig.openConsent(rp, context, fresh.credentials, width);
  const closed = second.popup.waitForEvent("close");
  await press(
    second.popup,
    second.popup.getByRole("button", { name: "Deny", exact: true }),
  ).catch((error) => {
    if (!second.popup.isClosed()) throw error;
  });
  await closed;
  await expect(list).toContainText(REFUSED, { timeout: 30_000 });
}

/** F. The plane says the same, to its own session, and no more. */
async function planeAnswers(main) {
  const minted = await planeCall(main, "/v1/principals/provisional", {
    method: "POST",
    body: "{}",
  });
  expect(minted.status).toBe(201);
  const asSession = {
    headers: { authorization: `Bearer ${minted.body.accessToken}` },
  };
  const trail = await planeCall(main, "/v1/audit/events?limit=50", asSession);
  expect(trail.status).toBe(200);
  expect(trail.body.events.map((event) => event.eventType)).toEqual(
    expect.arrayContaining([
      "access.request.created",
      "access.request.approved",
      "access.request.withdrawn",
      "access.request.denied",
      "access.sign_in.granted",
      "access.sign_in.revoked",
      "access.sign_in.denied",
    ]),
  );
  expect(JSON.stringify(trail.body)).not.toMatch(
    /records:read|rp\.example|Browser request|Deny this request/,
  );
  const inbox = await planeCall(main, "/v1/authorization-requests", asSession);
  expect(inbox.body.requests).toEqual([]);
  const decided = await planeCall(main, "/v1/authorization-requests", {
    ...asSession,
    method: "POST",
    body: "{}",
  });
  expect(decided.status, "the plane decides nothing").toBe(405);
  return asSession;
}

/** G. Locked again: the session answers 423 and the screen holds nothing. */
async function lockedAgain(main, asSession) {
  await lockVault(main);
  for (const route of ["/v1/audit/events", "/v1/authorization-requests"]) {
    const answer = await planeCall(main, route, asSession);
    expect(answer.status, `${route} after the lock`).toBe(423);
  }
  expect(await main.locator("body").innerText()).not.toMatch(
    /Receipts|Request approved|Test application/,
  );
}

export async function deviceInboxJourney({ width, rig }) {
  const {
    page: rp,
    context,
    credentials,
  } = await rig.seedJourney(false, INBOX_CAPABILITIES);
  await context.grantPermissions(["notifications"], { origin: ORIGIN });
  expect(hostChunk(), "the device host is its own chunk").toBeDefined();
  await lockedDevice(context, width);
  // The second tab: in the background, asked to ring if it can.
  const background = await openTab(context, width, "sessions", {
    background: true,
  });
  const main = await openTab(context, width, "requests");
  const mainDevice = await rig.authenticator(main, credentials);
  const panel = main.getByRole("region", {
    name: "Local requests",
    exact: true,
  });
  const t = { main, background, panel, width, rp, context, mainDevice, rig };
  await raisedAndTold(t);
  await approvedAndReceipted(t);
  await withdrawnAndDenied(t);
  await applicationSignIn(t);
  await lockedAgain(main, await planeAnswers(main));
  await context.close();
  console.log(
    `PASS ${width}px device inbox: a request is shown on the tab and told to a second tab without a service, approved and refused with the keyboard and the passkey, and every decision is a receipt; a locked device shows nothing and answers 423`,
  );
}
