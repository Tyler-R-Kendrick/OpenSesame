/**
 * J-CONFLICT: two pages edit one local application. A semantic save in A
 * makes B's save a conflict.
 */
import {
  addCapabilities,
  sealWithPin,
  unlockWithPin,
} from "./pages-journey.mjs";
import { expectInTray } from "./tray-contract.mjs";

import {
  createApplication,
  openApplication,
  openApplications,
} from "./j-local-application.mjs";

async function registerApp(page, name) {
  const row = await createApplication(page, name);
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
  const rowB = await openApplication(pageB, "Conflict relying party");
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
