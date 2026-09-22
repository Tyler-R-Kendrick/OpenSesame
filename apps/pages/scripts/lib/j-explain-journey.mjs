/**
 * J-EXPLAIN: Application Diagnostics uses the same evaluator as admission;
 * a saved failing policy test blocks candidate publication.
 */
import {
  addCapabilities,
  openSection,
  sealWithPassword,
} from "./pages-journey.mjs";

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
  return region;
}

export async function walkJExplain({ page, origin, base, check, snap }) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPassword(page);
  // Identity belongs to a capability: choose it before its rail row exists.
  await addCapabilities(page, [
    "External connectors",
    "Access authority",
    "Browser-local IAM",
    "Directory provisioning",
  ]);
  const panel = await openApplications(page);
  await panel
    .getByRole("button", { name: "New application", exact: true })
    .click();
  const nameField = panel.getByRole("textbox", { name: "Name", exact: true });
  await nameField.waitFor({ timeout: 8000 });
  await nameField.click();
  await page.keyboard.type("Explain relying party", { delay: 15 });
  // The name field commits on Enter: there is no separate Create button.
  await page.keyboard.press("Enter");
  await nameField.waitFor({ state: "hidden", timeout: 10000 });
  const row = panel
    .getByRole("listitem")
    .filter({ hasText: "Explain relying party" });
  await row.waitFor({ timeout: 10000 });
  await row.locator("summary", { hasText: "Application registration" }).click();
  await row.getByRole("heading", { name: "Diagnostics" }).waitFor({
    timeout: 10000,
  });
  await row.getByLabel("Simulated role").selectOption("member");
  await row.getByLabel("Requested scopes").fill("openid");
  await page.waitForTimeout(200);
  const decision = await row
    .locator("p")
    .filter({ hasText: /^Decision:/ })
    .innerText();
  check(
    /Decision:\s*(deny|allow|indeterminate)/i.test(decision),
    `decision shown: ${decision}`,
  );
  // Expect allow while member+openid on an empty policy is deny/indeterminate.
  await row.getByLabel("Expected decision").selectOption("allow");
  await row.getByRole("button", { name: "Save as policy test" }).click();
  await row
    .getByRole("alert")
    .filter({ hasText: /Candidate publication is blocked/i })
    .waitFor({ timeout: 8000 });
  check(true, "failing saved test blocks publication");
  await snap(page, "J-EXPLAIN-diagnostics");
}
