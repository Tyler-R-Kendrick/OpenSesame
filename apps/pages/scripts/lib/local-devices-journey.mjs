import { expect } from "@playwright/test";
import { openLocalAccessPage } from "./local-access-journey.mjs";

export async function localDevicesJourney({
  width,
  seedJourney,
  openConsent,
  approveConsent,
  authenticator,
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
  await authenticator(management);
  const panel = management.getByRole("region", {
    name: "Local authenticators",
  });
  const disclosure = panel.getByText("Passkeys", { exact: true });
  await disclosure.focus();
  await management.keyboard.press("Enter");
  const enroll = panel.getByRole("button", {
    name: "Enroll passkey",
    exact: true,
  });
  await expect(enroll).toBeEnabled();
  await enroll.focus();
  await management.keyboard.press("Enter");
  await expect(panel.getByLabel("Passkey status")).toHaveText(
    "Passkey enrolled.",
  );
  const revoke = panel.getByRole("button", {
    name: "Revoke passkey",
    exact: true,
  });
  await expect(revoke).toHaveCount(2);
  await revoke.first().focus();
  await management.keyboard.press("Enter");
  const keep = panel.getByRole("button", { name: "Keep passkey", exact: true });
  await keep.focus();
  await management.keyboard.press("Enter");
  await expect(revoke.first()).toBeFocused();
  await management.keyboard.press("Enter");
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
  const confirm = panel.getByRole("button", {
    name: "Confirm revocation",
    exact: true,
  });
  await confirm.focus();
  await management.keyboard.press("Enter");
  await expect(panel.getByLabel("Passkey status")).toHaveText(
    "Passkey revoked.",
  );
  await expect(revoke).toHaveCount(1);
  await expect(disclosure).toBeFocused();
  await page.getByRole("button", { name: "Check session" }).click();
  await expect(page.locator("output")).toHaveText("Session refused");
  expect(
    await management.evaluate(
      () => document.documentElement.scrollWidth > innerWidth,
    ),
  ).toBe(false);
  await context.close();
  console.log(
    `PASS ${width}px local devices: keyboard passkey enrollment, confirmed revocation, retained second key, real RP session refused without a backend`,
  );
}
