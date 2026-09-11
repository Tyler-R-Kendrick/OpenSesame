import { expect } from "@playwright/test";
import { openLocalAccessPage } from "./local-access-journey.mjs";

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
  await expect(page.locator("output")).toHaveText(/^Signed in locally: local_/);
  const management = await openLocalAccessPage(
    context,
    width,
    "devices",
    "identity",
  );
  const panel = management.getByRole("region", { name: "Devices" });
  await expect(panel).toBeVisible();
  await expect(panel.getByText("This device", { exact: true })).toBeVisible();
  await expect(panel.getByText("Passkeys", { exact: true })).toHaveCount(0);
  const rename = panel.getByRole("button", { name: /^Rename / });
  await rename.focus();
  await management.keyboard.press("Enter");
  const name = management.getByLabel("Name", { exact: true });
  await expect(name).toBeFocused();
  await management.keyboard.press("ControlOrMeta+A");
  await management.keyboard.insertText("Desk laptop");
  await management
    .getByRole("button", { name: "Save name", exact: true })
    .focus();
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
  await page.getByRole("button", { name: "Check session" }).click();
  await expect(page.locator("output")).toHaveText(/^Signed in locally: local_/);
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
