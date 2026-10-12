// Walk every Access subtree on a static deployment, including local
// connector creation and the resource collection without a Host.
export async function checkStaticAccess(page, check, snap, setStep) {
  for (const tab of [
    "Grants",
    "Requests",
    "Sessions",
    "Connectors",
    "Resources",
    "Policies",
  ]) {
    setStep(`B-access-${tab}`);
    await page
      .getByRole("treeitem", { name: tab, exact: true })
      .and(page.locator('[aria-level="2"]'))
      .click();
    await page.waitForTimeout(700);
    const tabText = await snap(page, `B-access-${tab}`);
    check(
      !/Something went wrong|Uncaught/i.test(tabText),
      `Access › ${tab} rendered`,
    );
    check(
      (await page.locator('[role="alert"]').count()) === 0,
      `Access › ${tab} shows no alert`,
    );
  }
  // Connectors is wholly local and lists access, never a directory form:
  // its one key adds access, with no Host and no failure (ADR 0115).
  await page
    .getByRole("treeitem", { name: "Connectors", exact: true })
    .and(page.locator('[aria-level="2"]'))
    .click();
  await page.waitForTimeout(700);
  check(
    (await page.getByLabel("Directory endpoint").count()) === 0 &&
      (await page
        .getByRole("button", { name: "Add connector access" })
        .count()) === 1 &&
      (await page.getByRole("tree", { name: "Connectors items" }).count()) > 0,
    "Access › Connectors lists access without a Host",
  );
  // Resources is served by the Identity API and this browser, never the
  // Host, so it must render its own panel rather than a Host note.
  await page
    .getByRole("treeitem", { name: "Resources", exact: true })
    .and(page.locator('[aria-level="2"]'))
    .click();
  await page.waitForTimeout(700);
  check(
    (await page.getByRole("tree", { name: "Local resources items" }).count()) >
      0,
    "Access › Resources renders without a Host",
  );
}
