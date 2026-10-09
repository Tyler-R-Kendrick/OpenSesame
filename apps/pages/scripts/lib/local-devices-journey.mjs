import { expect } from "@playwright/test";
import { openLocalAccessPage } from "./local-access-journey.mjs";
import { identityList } from "./local-directory-navigation.mjs";
import { tabTo } from "./local-iam-rig.mjs";

export async function localDevicesJourney({
  width,
  seedJourney,
  openConsent,
  approveConsent,
  captures,
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
  const management = await openLocalAccessPage(
    context,
    width,
    "devices",
    "identity",
  );
  const panel = management.locator(
    '.record-workspace[data-section="Identity"]',
  );
  await expect(panel).toBeVisible();
  const mine = await openThisBrowser(management, panel);
  await expect(mine.locator(".detail__meta")).toContainText("This device");
  await expect(panel.getByText("Passkeys", { exact: true })).toHaveCount(0);
  // The device you are on is edited, never removed.
  await expect(mine.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  const rename = mine.getByRole("button", { name: /^Edit / });
  await tabTo(management, rename);
  await management.keyboard.press("Enter");
  const name = management.getByLabel("Name", { exact: true });
  await expect(name).toBeVisible();
  await expect(name).toBeFocused();
  await management.keyboard.press("ControlOrMeta+A");
  await management.keyboard.insertText("Desk laptop");
  await expect(name).toHaveValue("Desk laptop");
  await tabTo(
    management,
    management.getByRole("button", { name: "Save changes", exact: true }),
  );
  await management.keyboard.press("Enter");
  await expect(
    panel.getByRole("heading", { name: "Desk laptop", exact: true }),
  ).toBeVisible();
  await management.locator(".wordmark").evaluateAll(async (nodes) => {
    await Promise.all(
      nodes.flatMap((node) =>
        node
          .getAnimations({ subtree: true })
          .map((animation) => animation.finished),
      ),
    );
  });
  await management.screenshot({
    path: `${captures}/local-devices-controls-${width}.png`,
    fullPage: true,
  });
  await management.evaluate(() => {
    for (const node of document.querySelectorAll("*")) node.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await management.screenshot({
    path: `${captures}/local-devices-${width}.png`,
    fullPage: true,
  });
  // The relying page answers a check with "Session active". Its sign-in
  // text is what the output held before the click, so matching that passed
  // only when it was read before the check returned.
  await tabTo(page, page.getByRole("button", { name: "Check session" }));
  await page.keyboard.press("Enter");
  await expect(page.locator("output")).toHaveText("Session active", {
    timeout: 30_000,
  });
  expect(
    await management.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await context.close();
  console.log(
    `PASS ${width}px local devices: this browser is listed and renamed, session still valid without a backend`,
  );
}

/** Consent and seed tabs can have the same browser name: identify the real
 * current browser by the selected detail's status, through native tree keys. */
async function openThisBrowser(page, panel) {
  const tree = panel.locator('.vtree__rows[role="tree"]');
  const devices = tree.getByRole("treeitem").filter({
    has: page.locator(".vtree__dim", { hasText: /^\.device$/ }),
  });
  await expect(devices.first()).toBeVisible();
  const ids = await devices.evaluateAll((rows) =>
    rows.map((row) => row.dataset.recordId),
  );
  for (const id of ids) {
    await identityList(page, tabTo);
    const row = tree.locator(`[data-record-id="${id}"]`);
    const index = await row.evaluate((node) =>
      [...node.parentElement.querySelectorAll('[role="treeitem"]')].indexOf(
        node,
      ),
    );
    await tabTo(page, tree);
    await page.keyboard.type(`${index + 1}gg`);
    await page.keyboard.press("Enter");
    const detail = panel.locator(".vault__detail");
    await expect(detail.locator(".detail")).toHaveAttribute("id", id);
    if (
      (await detail.locator(".detail__meta").innerText()).includes(
        "This device",
      )
    )
      return detail;
  }
  throw new Error("Current browser is missing from the vault device list");
}
