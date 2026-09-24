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
  const records = management.getByRole("region", {
    name: "Local access records",
  });
  await expect(records).toBeVisible();
  if (view === "sessions") {
    // Sessions lists sessions and Grants lists grants: the grant this
    // journey revokes is on Grants, and Sessions shows the passkey session
    // the consent opened, with no grant rows repeated under it.
    await expect(
      records.getByRole("heading", { name: "Local sessions" }),
    ).toBeVisible();
    await expect(
      records.getByText("Local test person", { exact: true }),
    ).toBeVisible();
    await expect(
      records.getByRole("button", { name: "Revoke grant" }),
    ).toHaveCount(0);
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
  await expect(
    records.getByRole("heading", { name: "Local application grants" }),
  ).toBeVisible();
  await expect(
    records.getByRole("button", { name: "Revoke session" }),
  ).toHaveCount(0);
  await expect(
    records.getByText("Local test person → Test application", { exact: true }),
  ).toBeVisible();
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
  ).toBeVisible();
  await expect(
    records.getByRole("button", { name: "Reload local access records" }),
  ).toBeFocused();
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
