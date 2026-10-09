import { expect } from "@playwright/test";
import { chooseCapabilities, unlockVault } from "./choose-capabilities.mjs";

/** Revoke real cross-origin consent from a second, independently unlocked tab. */
export async function localAccessJourney({
  width,
  seedJourney,
  openConsent,
  approveConsent,
  captures,
  view = "sessions",
}) {
  const { page, context, credentials } = await seedJourney(false);
  const { popup } = await openConsent(page, context, credentials, width);
  await approveConsent(page, popup, width);
  await expect(page.locator("output")).toHaveText(
    /^Signed in locally: local_/,
    {
      timeout: 30_000,
    },
  );
  const management = await openLocalAccessPage(context, width, view);
  const records = accessWorkspace(management);
  await openAuthorityRecord(management, records, view);
  if (view === "sessions") {
    await assertIsolatedPasskeySession(records);
    expect(
      await management.evaluate(
        () => document.documentElement.scrollWidth > innerWidth,
      ),
    ).toBe(false);
    await context.close();
    console.log(
      `PASS ${width}px local sessions: the consent's passkey session is listed on its own, with no grant repeated under it`,
    );
    return;
  }
  await assertApplicationGrant(records);
  await revokeApplicationGrant(management, records, width, captures, view);
  await page.getByRole("button", { name: "Check session" }).click();
  await expect(page.locator("output")).toHaveText("Session refused");
  await expect(page.locator("output")).toHaveAttribute(
    "data-reason",
    "authorization_unavailable",
  );
  const overflow = await management.evaluate(
    () => document.documentElement.scrollWidth > innerWidth,
  );
  expect(overflow).toBe(false);
  await context.close();
  console.log(
    `PASS ${width}px local ${view}: second-tab encrypted ledger, keyboard confirmation/cancel/recovery, custodian revocation blocks the real relying party`,
  );
}

async function openAuthorityRecord(management, records, view) {
  const listTitle =
    view === "sessions" ? "Local sessions" : "Local application grants";
  await expect(
    records.getByRole("tree", { name: `${listTitle} items` }),
  ).toBeVisible();
  const record = records.getByRole("treeitem", {
    name:
      view === "sessions"
        ? /^Local test person\b/
        : /^Local test person → Test application/,
  });
  await record.focus();
  await management.keyboard.press("Enter");
}

async function assertIsolatedPasskeySession(records) {
  // Sessions lists sessions and Grants lists grants: the grant this
  // journey revokes is on Grants, and Sessions shows the passkey session
  // the consent opened, with no grant rows repeated under it.
  await expect(
    records.getByRole("heading", { name: "Local test person", exact: true }),
  ).toBeVisible();
  await expect(
    records.locator(".frow").filter({ hasText: "Passkey session" }),
  ).toBeVisible();
  await expect(
    records.getByRole("button", { name: "Revoke grant" }),
  ).toHaveCount(0);
}

async function assertApplicationGrant(records) {
  await expect(
    records.getByRole("heading", {
      name: "Local test person → Test application",
      exact: true,
    }),
  ).toBeVisible();
  await expect(
    records.getByRole("button", { name: "Revoke session" }),
  ).toHaveCount(0);
  await expect(
    records.locator(".frow").filter({ hasText: "records:read" }),
  ).toBeVisible();
}

async function revokeApplicationGrant(
  management,
  records,
  width,
  captures,
  view,
) {
  const revoke = records.getByRole("button", {
    name: "Revoke grant",
    exact: true,
  });
  await revoke.focus();
  await management.keyboard.press("Enter");
  const cancel = management.getByRole("button", { name: "Cancel revocation" });
  await expect(cancel).toBeFocused();
  await captureConfirmation(management, width, captures, view);
  await management.keyboard.press("Enter");
  await expect(revoke).toBeFocused();
  await management.keyboard.press("Enter");
  await management.keyboard.press("Shift+Tab");
  await expect(
    management.getByRole("button", { name: "Confirm revocation" }),
  ).toBeFocused();
  await management.keyboard.press("Enter");
  await expect(
    records.getByText("Application grant revoked.", { exact: true }),
  ).toHaveText("Application grant revoked.");
  await expect(records.locator(".vault__list")).toBeVisible();
  expect(
    await records.locator(".vault__list").evaluate((list) => {
      const active = document.activeElement;
      return list.contains(active) && active.getClientRects().length > 0;
    }),
  ).toBe(true);
  const reload = records.getByRole("button", {
    name: "Reload local access records",
  });
  await tabToAccessControl(management, reload);
  await expect(reload).toBeFocused();
  await management.keyboard.press("Enter");
}

export { chooseCapabilities };

/** The capabilities every journey in this suite needs before it starts. */
export const LOCAL_IAM_CAPABILITIES = ["Access authority", "Browser-local IAM"];

const BASE = "https://tyler-r-kendrick.github.io/OpenSesame";

export async function openLocalAccessPage(
  context,
  width,
  view,
  section = "access",
) {
  const page = await context.newPage();
  page.on("pageerror", (error) => {
    throw error;
  });
  await page.setViewportSize({ width, height: 900 });
  const base = BASE;
  await page.goto(`${base}/${section}?view=${view}`);
  await unlockVault(page);
  // unlockVault presses Enter and returns; the unlock itself (the password
  // KDF, then this tab's first read of the encrypted ledger) is still running.
  // Wait for it here, on the budget this suite gives every slow step, so a
  // caller's first assertion is not left to cover a KDF in its default 5 s.
  await expect(page.getByLabel("Password", { exact: true })).toHaveCount(0, {
    timeout: 30_000,
  });
  return page;
}

async function captureConfirmation(management, width, captures, view) {
  const name = view === "grants" ? "local-grants" : "local-access";
  await management.locator(".wordmark").evaluateAll(async (nodes) => {
    await Promise.all(
      nodes.flatMap((node) =>
        node
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished),
      ),
    );
  });
  for (const button of [
    management.getByRole("button", { name: "Cancel revocation" }),
    management.getByRole("button", { name: "Confirm revocation" }),
  ]) {
    const bounds = await button.boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(width);
    expect(
      await button.evaluate((element) => {
        const box = element.getBoundingClientRect();
        return element.contains(
          document.elementFromPoint(
            box.x + box.width / 2,
            box.y + box.height / 2,
          ),
        );
      }),
    ).toBe(true);
  }
  await management.screenshot({
    path: `${captures}/${name}-${width}.png`,
    fullPage: true,
  });
  await management.evaluate(() => {
    for (const element of document.querySelectorAll("*")) element.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await management.screenshot({
    path: `${captures}/${name}-top-${width}.png`,
    fullPage: true,
  });
}

export function accessWorkspace(page) {
  return page.locator('.record-workspace[data-section="Access"]');
}

export async function returnToAccessList(page) {
  const back = accessWorkspace(page).locator(".record-workspace__back");
  if (await back.isVisible()) await back.click();
  await expect(accessWorkspace(page).locator(".vault__list")).toBeVisible();
}

/** Desktop path-strip keys and the phone's vault action menu execute the same commands. */
export async function runAccessCommand(page, label) {
  const key = accessWorkspace(page)
    .getByRole("button", { name: label, exact: true })
    .filter({ visible: true });
  if (await key.count()) return key.click();
  await returnToAccessList(page);
  if (await key.count()) return key.click();
  const add = accessWorkspace(page).locator(".record-workspace__add");
  await add.focus();
  await page.keyboard.press("Shift+F10");
  await page.getByRole("menuitem", { name: label, exact: true }).click();
}

/** Reach a form field using native Tab after the workspace changes panes. */
export async function tabToAccessControl(page, target) {
  for (let step = 0; step < 60; step++) {
    if (await target.evaluate((node) => node === document.activeElement))
      return;
    await page.keyboard.press("Tab");
  }
  throw new Error("Keyboard could not reach local access control");
}
