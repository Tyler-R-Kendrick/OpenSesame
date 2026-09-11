import { expect } from "@playwright/test";
import { openLocalAccessPage } from "./local-access-journey.mjs";

export async function localPolicyJourney({
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
  await page.getByRole("button", { name: "Check session" }).click();
  await expect(page.locator("output")).toHaveText("Session active");
  const management = await openLocalAccessPage(context, width, "policies");
  const panel = management.getByRole("region", {
    name: "Local application policies",
  });
  const heading = panel.getByRole("heading", {
    name: "Test application",
    exact: true,
  });
  await expect(heading).toBeVisible();
  const row = heading.locator("..");
  await row.getByText("Application registration", { exact: true }).click();
  const owner = row.getByRole("checkbox", { name: "records:read: owner" });
  await expect(owner).toBeChecked();
  await owner.focus();
  await management.keyboard.press("Space");
  await expect(owner).not.toBeChecked();
  await capturePolicy(management, width, captures);
  const save = row.getByRole("button", { name: "Save registration" });
  await save.focus();
  await management.keyboard.press("Enter");
  await expect(save).toBeEnabled();
  await row.getByRole("button", { name: "Reload registration" }).click();
  await expect(
    row.getByRole("checkbox", { name: "records:read: owner" }),
  ).not.toBeChecked();
  await page.getByRole("button", { name: "Check session" }).click();
  await expect(page.locator("output")).toHaveText("Session refused");
  await expect(page.locator("output")).toHaveAttribute(
    "data-reason",
    "authorization_unavailable",
  );
  await context.close();
  console.log(
    `PASS ${width}px local policies: keyboard scope-role change persists and invalidates real RP access without Host`,
  );
}

async function capturePolicy(page, width, captures) {
  await page
    .getByRole("button", { name: "Save registration" })
    .scrollIntoViewIfNeeded();
  await page.screenshot({
    path: `${captures}/local-policy-${width}.png`,
    fullPage: true,
  });
  await page.evaluate(() => {
    for (const element of document.querySelectorAll("*")) element.scrollTop = 0;
    window.scrollTo(0, 0);
  });
  await page.screenshot({
    path: `${captures}/local-policy-top-${width}.png`,
    fullPage: true,
  });
}
