import { chooseCapabilitiesHere } from "./mobile-capabilities.mjs";
import { auditGestures } from "./mobile-gestures.mjs";

/** Every section behind the sections drawer, and the tab the Access strip hides. */
export async function sectionStops(page, stop, { audit, harness, openTab }) {
  await chooseCapabilitiesHere(page, ["External connectors"], {
    harness,
    openTab,
  });
  for (const [label, name] of [
    ["connections", "Connections"],
    ["access", "Access"],
    ["identity", "Identity"],
    ["settings", "Settings"],
  ]) {
    if (await openTab(page, name)) await audit(page, stop(label));
    if (name === "Connections") {
      await page.locator("#catalog-attio a").tap();
      await page
        .getByRole("heading", { name: "Attio", exact: true })
        .first()
        .waitFor();
      await audit(page, stop("connections-attio"));
    }
  }
  // Settings is the last stop: a finger has no key to press, so the keymap
  // it is given is the Gestures tab (ADR 0170), made with real touches.
  await auditGestures(page, harness, stop, audit);
  // Access keeps five more tabs in a scrolling strip; the far one has to be
  // reachable and has to bring itself into view once it is current.
  if (!(await openTab(page, "Access"))) return;
  const policies = page
    .getByRole("treeitem", { name: "Policies", exact: true })
    .and(page.locator('[aria-level="2"]'));
  if ((await policies.count()) === 0) {
    harness.check(
      false,
      `${stop("access-policies")}: the Policies tab is missing`,
    );
    return;
  }
  await policies.scrollIntoViewIfNeeded();
  await policies.tap();
  await page.waitForTimeout(500);
  await audit(page, stop("access-policies"));
}
