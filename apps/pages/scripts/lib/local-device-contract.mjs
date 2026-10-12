import { expect } from "@playwright/test";
import {
  openIdentityRecord,
  openIdentityView,
} from "./local-directory-navigation.mjs";

// Identity › Devices lists the browsers that opened this vault, driven from
// the keyboard alone: this browser is listed and never removable, it is
// renamed (and named back) from its pencil key, and no key invents a device
// (ADR 0169 — the tailnet's real machines are the optional device manager's,
// above this list).
export async function localDeviceContract(page, tabTo) {
  await openIdentityView(page, tabTo, "Devices");
  const panel = page.locator('.record-workspace[data-section="Identity"]');
  const device = panel
    .locator(".vtree__rows")
    .getByRole("treeitem")
    .filter({ has: page.locator(".vtree__dim", { hasText: /^\.device$/ }) })
    .first();
  await expect(device).toBeVisible();
  const label = (await device.locator(".vtree__name").innerText()).replace(
    /\.device$/,
    "",
  );
  await openIdentityRecord(page, tabTo, label);
  const mine = panel.locator(".vault__detail");
  await expect(mine.locator(".detail__meta")).toContainText("This device");
  await expect(mine).toHaveCount(1);
  await expect(mine.getByRole("button", { name: /^Remove / })).toHaveCount(0);
  await expect(
    panel.getByRole("button", { name: /New device|Register/ }),
  ).toHaveCount(0);

  const edit = mine.getByRole("button", { name: `Edit ${label}`, exact: true });
  await tabTo(page, edit);
  await page.keyboard.press("Enter");
  const name = panel.getByRole("textbox", { name: "Name", exact: true });
  await expect(name).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Keyboard laptop");
  await page.keyboard.press("Enter");
  const renamed = panel.getByRole("heading", {
    name: "Keyboard laptop",
    exact: true,
  });
  await expect(renamed).toBeVisible();

  const again = mine.getByRole("button", {
    name: "Edit Keyboard laptop",
    exact: true,
  });
  await tabTo(page, again);
  await page.keyboard.press("Enter");
  await expect(name).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type(label);
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("heading", { name: label, exact: true }),
  ).toBeVisible();
}
