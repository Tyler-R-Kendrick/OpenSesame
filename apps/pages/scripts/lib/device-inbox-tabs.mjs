/**
 * The tabs and keys behind `verify-device-inbox.mjs` and the evidence capture
 * (ADR 0162): a tab that records what the page asks of the browser's
 * notification API, a tab that is told it is in the background, and the
 * keyboard's own road to a control.
 *
 * Every wait here is for a condition, bounded by a stated timeout, never for a
 * stretch of time: the journey runs on machines of very different speed.
 */

import { unlockVault } from "./choose-capabilities.mjs";
import { expect } from "./patient-expect.mjs";

export const ORIGIN = "https://tyler-r-kendrick.github.io";
export const BASE = `${ORIGIN}/OpenSesame`;

/** The longest any one thing is waited for, on a slow machine. */
export const PATIENCE = 60_000;

/** Keyboard activation: focus the control, then press Enter. */
export async function press(page, locator) {
  // A key that is not enabled yet takes the Enter and does nothing with it.
  await expect(locator).toBeEnabled({ timeout: PATIENCE });
  await locator.focus();
  await page.keyboard.press("Enter");
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

/**
 * Recorded, not shown, on every tab: each `Notification` that is made, each
 * time permission is asked for, and the notifications themselves (so a click
 * can be made on one). A check that nothing rang in the front tab, or that
 * nothing asked at load, can fail only because this is installed there too.
 */
function recordNotifications() {
  const Real = globalThis.Notification;
  globalThis.__notified = [];
  globalThis.__asked = [];
  globalThis.__instances = [];
  globalThis.Notification = class extends Real {
    constructor(title, options) {
      super(title, options);
      globalThis.__notified.push({
        title,
        body: options?.body,
        tag: options?.tag,
        data: options?.data,
      });
      globalThis.__instances.push(this);
    }
  };
  globalThis.Notification.requestPermission = (...args) => {
    globalThis.__asked.push(Date.now());
    return Real.requestPermission(...args);
  };
}

/** A headless tab is never hidden; this one is told it is. */
function behindAnotherTab() {
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => true,
  });
  Object.defineProperty(document, "visibilityState", {
    configurable: true,
    get: () => "hidden",
  });
}

export async function openTab(
  context,
  width,
  view,
  { background = false } = {},
) {
  const page = await context.newPage();
  page.setDefaultTimeout(PATIENCE);
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.addInitScript(recordNotifications);
  if (background) await page.addInitScript(behindAnotherTab);
  await page.setViewportSize({ width, height: 900 });
  await page.goto(`${BASE}/access?view=${view}`);
  await unlockVault(page);
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0, {
    timeout: PATIENCE,
  });
  return page;
}

export const notified = (page) =>
  page.evaluate(() => globalThis.__notified ?? []);

/** Each time this tab asked the browser for the notification permission. */
export const asked = (page) => page.evaluate(() => globalThis.__asked ?? []);

/** Click the newest system notification this tab made, the way the browser does. */
export async function clickNotification(page) {
  await page.evaluate(() => {
    const [latest] = globalThis.__instances.slice(-1);
    if (!latest?.onclick) throw new Error("no notification to click");
    latest.onclick(new Event("click"));
  });
}

/** What the bell says in this layout: the bar's key, or the phone's More. */
export function bell(page, width) {
  return width < 900
    ? page.locator(".topbar__more.is-attn")
    : page.locator(".cx__btn--attn");
}

/**
 * Focus has landed somewhere a person can act from: on a visible control or
 * region of the page, not on the document itself and not in nothing. The
 * keyboard contract asks this of every arrival, including one made by a key
 * on the bell or a click on a notification.
 */
export async function expectFocusLanded(page, where) {
  await expect
    .poll(
      () =>
        page.evaluate(() => {
          const node = document.activeElement;
          if (!node || node === document.body) return "nowhere";
          const box = node.getBoundingClientRect();
          return box.width > 0 && box.height > 0 ? "somewhere" : "hidden";
        }),
      { message: `focus after ${where}`, timeout: PATIENCE },
    )
    .toBe("somewhere");
}

export async function raiseRequest(main, panel, reason) {
  const create = panel.getByRole("button", {
    name: "New local request",
    exact: true,
  });
  await press(main, create);
  await expect(panel.getByLabel("Requesting identity")).toBeFocused();
  // Signed in is the condition. A person who already is has no key to press;
  // one whose session is still being read has a key that is not yet enabled,
  // or that is enabled for an instant and then is not. Press it whenever it is
  // there to press, and wait for the status, not for the key.
  const signIn = panel.getByRole("button", {
    name: "Sign in locally",
    exact: true,
  });
  const status = panel.getByLabel("Local session status");
  const signedIn = /Signed in locally with a passkey/;
  // A ceremony that is under way leaves the key enabled, and pressing it again
  // starts another that cancels the first: on a slow machine that is a loop
  // that never settles. Press, then give the ceremony its time before pressing
  // again.
  let pressedAt = Number.NEGATIVE_INFINITY;
  const CEREMONY_MS = 15_000;
  await expect
    .poll(
      async () => {
        if (signedIn.test(await status.innerText())) return "signed-in";
        const keys = await signIn.count();
        if (
          keys > 0 &&
          Date.now() - pressedAt > CEREMONY_MS &&
          (await signIn.isEnabled())
        ) {
          pressedAt = Date.now();
          await signIn.focus();
          await main.keyboard.press("Enter");
        }
        // Say what was seen, so a run that never signs in reports where it stood.
        return `waiting (status: ${JSON.stringify(await status.innerText())}, sign-in keys: ${keys})`;
      },
      { timeout: PATIENCE, intervals: [250, 500, 1000, 2000] },
    )
    .toBe("signed-in");
  const field = panel.getByLabel("Reason", { exact: true });
  await expect(field).toBeVisible({ timeout: PATIENCE });
  await field.fill(reason);
  await press(
    main,
    panel.getByRole("button", { name: "Create local request", exact: true }),
  );
  await expect(
    panel.getByText("Local request created. No access was granted."),
  ).toBeVisible({ timeout: PATIENCE });
}

export async function receipts(main, width) {
  await press(main, main.getByRole("tab", { name: /^Sessions/ }));
  const list = main.locator("#access-receipts");
  await expect(list).toBeVisible({ timeout: PATIENCE });
  expect(
    await main.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
    `${width}px: Receipts do not scroll the page sideways`,
  ).toBe(false);
  return list;
}
