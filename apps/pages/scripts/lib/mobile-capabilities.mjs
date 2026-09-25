import {
  ALWAYS_ON_TITLES,
  awaitCapabilitySections,
  capabilityOffSwitch,
} from "./always-on.mjs";

/**
 * Choose capabilities from Settings › Capabilities, at whatever width this
 * walk is running: a phone reaches sections through the drawer, a tablet
 * through the rail. Every control is tapped, because this is the touch gate.
 */
export async function chooseCapabilitiesHere(
  page,
  titles,
  { harness, openTab },
) {
  const openSettings = async () => {
    const drawerKey = page.getByRole("button", { name: "Sections" }).first();
    if (await drawerKey.count()) {
      await openTab(page, "Settings");
      return;
    }
    await page.locator(".railtree__row", { hasText: "settings" }).first().tap();
    await page.waitForTimeout(700);
  };
  for (const title of titles) {
    // Always on (ADR 0135): in every plan, with no row to add it from.
    if (ALWAYS_ON_TITLES.has(title)) continue;
    await openSettings();
    await page.waitForTimeout(500);
    const tab = page.getByRole("link", { name: "Capabilities", exact: true });
    if ((await tab.count()) === 0) {
      harness.check(false, "settings has no Capabilities tab");
      return;
    }
    await tab.tap();
    await page.waitForTimeout(700);
    await awaitCapabilitySections(page);
    const add = capabilityOffSwitch(page, title);
    if ((await add.count()) === 0) continue;
    await add.tap();
    await page.waitForTimeout(600);
    const apply = page.getByTestId("capability-apply");
    if ((await apply.count()) === 0 || (await apply.isDisabled())) {
      harness.check(false, `${title}: Apply was not offered`);
      return;
    }
    await apply.tap();
    await page.waitForTimeout(2200);
  }
}
