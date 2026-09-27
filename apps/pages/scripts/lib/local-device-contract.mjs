import { expect } from "@playwright/test";

// Identity › Devices carries the same commands as every other Identity list,
// driven from the keyboard alone: register a device from the head's add key,
// edit it, then remove it behind the armed key — and the device you are on
// is never removable.
export async function localDeviceContract(page, tabTo) {
  await tabTo(page, page.getByRole("tab", { name: "Devices", exact: true }));
  await page.keyboard.press("Enter");
  const panel = page.getByRole("region", { name: "Devices", exact: true });
  const mine = panel
    .getByRole("listitem")
    .filter({ has: page.getByRole("img", { name: "This device" }) });
  await expect(mine).toHaveCount(1);
  await expect(mine.getByRole("button", { name: /^Remove / })).toHaveCount(0);

  const create = panel.getByRole("button", { name: "New device", exact: true });
  await tabTo(page, create);
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("textbox", { name: "Name", exact: true }),
  ).toBeFocused();
  await page.keyboard.type("Keyboard laptop");
  await page.keyboard.press("Tab");
  const platform = panel.getByRole("combobox", { name: "Platform" });
  await expect(platform).toBeFocused();
  // Type-ahead on the closed select, as a person choosing by keyboard does.
  await page.keyboard.press("w");
  await expect(platform).toHaveValue("Windows");
  await tabTo(
    page,
    panel.getByRole("button", { name: "Register device", exact: true }),
  );
  await page.keyboard.press("Enter");
  let label = "Keyboard laptop";
  const row = () => panel.getByRole("listitem").filter({ hasText: label });
  await expect(
    row().getByRole("img", {
      name: "Registered, not yet opened on that device",
      exact: true,
    }),
  ).toBeVisible();

  await tabTo(
    page,
    row().getByRole("button", { name: `Edit ${label}`, exact: true }),
  );
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("textbox", { name: "Name", exact: true }),
  ).toBeFocused();
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.type("Renamed laptop");
  await page.keyboard.press("Enter");
  label = "Renamed laptop";
  await expect(
    row().getByRole("heading", { name: label, exact: true }),
  ).toBeVisible();

  const remove = row().getByRole("button", {
    name: `Remove ${label}`,
    exact: true,
  });
  await tabTo(page, remove);
  await page.keyboard.press("Enter");
  await tabTo(
    page,
    row().getByRole("button", { name: `Keep ${label}`, exact: true }),
  );
  await page.keyboard.press("Enter");
  await expect(remove).toBeFocused();
  await page.keyboard.press("Enter");
  await tabTo(
    page,
    row().getByRole("button", {
      name: `Confirm removing ${label}`,
      exact: true,
    }),
  );
  await page.keyboard.press("Enter");
  await expect(
    panel.getByRole("heading", { name: label, exact: true }),
  ).toHaveCount(0);
  // The row left with the key that had focus; focus lands on the add key,
  // not on the page's top.
  await expect(create).toBeFocused();
}
