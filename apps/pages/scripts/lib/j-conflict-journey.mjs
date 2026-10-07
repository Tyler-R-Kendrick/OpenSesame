/**
 * J-CONFLICT: two pages edit one local application. A semantic save in A
 * makes B's save a conflict.
 */
import {
  addCapabilities,
  openSection,
  sealWithPin,
  unlockWithPin,
} from "./pages-journey.mjs";
import { expectInTray } from "./tray-contract.mjs";

async function openApplications(page) {
  const region = page.getByRole("region", {
    name: "Local applications",
    exact: true,
  });
  if (!(await region.isVisible().catch(() => false))) {
    await openSection(page, "identity/");
    await page.getByRole("tab", { name: "Applications", exact: true }).click();
    await region.waitFor({ timeout: 15000 });
  }
}

async function registerApp(page, name) {
  const panel = page.getByRole("region", {
    name: "Local applications",
    exact: true,
  });
  await panel
    .getByRole("button", { name: "New application", exact: true })
    .click();
  const nameField = panel.getByRole("textbox", { name: "Name", exact: true });
  await nameField.waitFor({ timeout: 8000 });
  await nameField.click();
  await page.keyboard.type(name, { delay: 15 });
  // The name field commits on Enter: there is no separate Create button.
  await page.keyboard.press("Enter");
  await nameField.waitFor({ state: "hidden", timeout: 10000 });
  const row = panel.getByRole("listitem").filter({ hasText: name });
  await row.waitFor({ timeout: 10000 });
  await row.locator("summary", { hasText: "Application registration" }).click();
  const organization = row.getByRole("combobox", {
    name: "Organization",
    exact: true,
  });
  await organization.waitFor({ timeout: 8000 });
  await organization.selectOption({ index: 1 });
  await row
    .getByRole("textbox", { name: "Redirect URIs (one per line)", exact: true })
    .fill("https://rp.example.test/callback");
  await row
    .getByRole("button", { name: "Save registration", exact: true })
    .click();
  await row
    .getByText("Registered locally. Access still requires authorization.", {
      exact: true,
    })
    .waitFor({ timeout: 10000 });
  return row;
}

export async function walkJConflict({
  page,
  context,
  origin,
  base,
  check,
  snap,
}) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPin(page);
  // Identity belongs to a capability: choose it before its rail row exists.
  await addCapabilities(page, [
    "External connectors",
    "Access authority",
    "Browser-local IAM",
    "Directory provisioning",
  ]);
  await openApplications(page);
  const rowA = await registerApp(page, "Conflict relying party");
  await snap(page, "J-CONFLICT-registered");
  const pageB = await context.newPage();
  await pageB.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await unlockWithPin(pageB);
  await openApplications(pageB);
  const rowB = pageB
    .getByRole("region", { name: "Local applications", exact: true })
    .getByRole("listitem")
    .filter({ hasText: "Conflict relying party" });
  await rowB
    .locator("summary", { hasText: "Application registration" })
    .click();
  await rowA
    .getByRole("textbox", { name: "Redirect URIs (one per line)", exact: true })
    .fill("https://rp.example.test/a");
  await rowA
    .getByRole("button", { name: "Save registration", exact: true })
    .click();
  await rowA
    .getByText("Registered locally. Access still requires authorization.", {
      exact: true,
    })
    .waitFor({ timeout: 10000 });
  await rowB
    .getByRole("textbox", { name: "Redirect URIs (one per line)", exact: true })
    .fill("https://rp.example.test/b");
  await rowB
    .getByRole("button", { name: "Save registration", exact: true })
    .click();
  await expectInTray(pageB, /changed\. Reload before saving/i);
  check(true, "stale tab is refused, in the tray");
  await snap(pageB, "J-CONFLICT-stale");
  // Return to the original tab and verify the stale save left its registration intact.
  await page.bringToFront();
  const savedRedirects = await rowA
    .getByRole("textbox", { name: "Redirect URIs (one per line)", exact: true })
    .inputValue();
  check(
    savedRedirects === "https://rp.example.test/a",
    "the stale tab cannot overwrite the original tab's saved registration",
  );
  await snap(page, "J-CONFLICT-saved-registration");
  await pageB.close();
}
