/**
 * J-APP / J-RECIPE (local plane): register an application, inspect setup
 * copy, export a recipe without secrets, bind an organization, apply twice.
 */
import { addCapabilities, sealWithPin } from "./pages-journey.mjs";

import { createApplication, openApplications } from "./j-local-application.mjs";

export async function walkJAppRecipe({ page, origin, base, check, snap }) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPin(page);
  // Identity belongs to a capability: choose it before its rail row exists.
  await addCapabilities(page, [
    "External connectors",
    "Access authority",
    "Browser-local IAM",
    "Directory provisioning",
  ]);
  const panel = await openApplications(page);
  const row = await createApplication(page, "Recipe relying party");
  const organization = row.getByRole("combobox", {
    name: "Organization",
    exact: true,
  });
  await organization.selectOption({ index: 1 });
  const orgId = await organization.inputValue();
  check(orgId !== "", "application is bound to an organization");
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
  check(true, "registration is not consent");
  await snap(page, "J-APP-registered");
  const exported = row.getByLabel("Exported recipe");
  await exported.waitFor({ timeout: 8000 });
  const recipeText = await exported.inputValue();
  check(!recipeText.includes("must-not-export"), "recipe omits clientSecret");
  check(
    !recipeText.includes('"clientSecret"'),
    "recipe JSON has no clientSecret key",
  );
  check(
    recipeText.includes("opensesame.recipe.v1"),
    "recipe has schema version",
  );
  await row.getByLabel("Organization binding").fill(orgId);
  await row.getByLabel("Import recipe JSON").fill(recipeText);
  await row.getByRole("button", { name: "Apply import" }).click();
  await row.getByText(/Applied /).waitFor({ timeout: 10000 });
  const first = await row
    .locator("p.hint")
    .filter({ hasText: /Applied / })
    .innerText();
  check(/Applied /.test(first), `first import applied: ${first}`);
  await row.getByRole("button", { name: "Apply import" }).click();
  await page.waitForTimeout(800);
  const hints = await row.locator("p.hint").allInnerTexts();
  const last =
    hints
      .filter((line) =>
        /Applied |same applicationId|Missing|changed/.test(line),
      )
      .at(-1) ?? "";
  check(
    /Applied /.test(last) && !/duplicate/i.test(last),
    `repeat import stays idempotent: ${last}`,
  );
  const apps = panel
    .getByRole("treeitem")
    .filter({ hasText: "Recipe relying party" });
  check(
    (await apps.count()) === 1,
    "repeat import did not duplicate the application",
  );
  await snap(page, "J-RECIPE-applied");
}
