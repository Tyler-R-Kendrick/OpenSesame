/**
 * J-CONFLICT: two pages edit one local application. A semantic save in A
 * makes B's save a conflict. A's comment-only source save does not invalidate
 * grants.
 */
import {
  openSection,
  sealWithPassword,
  setTextarea,
  unlockWithPassword,
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
  await sealWithPassword(page);
  await openApplications(page);
  const rowA = await registerApp(page, "Conflict relying party");
  await snap(page, "J-CONFLICT-registered");
  const pageB = await context.newPage();
  await pageB.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await unlockWithPassword(pageB);
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
  await rowB.getByRole("alert").waitFor({ timeout: 10000 });
  const alert = await rowB.getByRole("alert").innerText();
  check(
    /changed\. Reload before saving/i.test(alert),
    `stale tab is refused: ${alert}`,
  );
  await snap(pageB, "J-CONFLICT-stale");
  await rowA.getByRole("button", { name: "Source", exact: true }).click();
  const source = rowA.locator("textarea[id^='app-source-']");
  await source.waitFor({ timeout: 8000 });
  const current = await source.inputValue();
  await setTextarea(
    page,
    "textarea[id^='app-source-']",
    `# keep grants\n${current}`,
  );
  await rowA.getByRole("button", { name: "Save source", exact: true }).click();
  await rowA
    .getByText("Saved comments. Application grants were not invalidated.", {
      exact: true,
    })
    .waitFor({ timeout: 10000 });
  check(true, "comment-only source save does not invalidate grants");
  await snap(page, "J-CONFLICT-comment");
  await pageB.close();
}
