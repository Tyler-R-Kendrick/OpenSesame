/** Keyboard entry to the vault's current live-sharing sheet. */
import { expect } from "@playwright/test";
import { approveByKeyboard } from "./capability-keyboard-contract.mjs";

export const SHARE_PANEL = '[role="dialog"][aria-label="Share personal"]';

/** A sealed local vault with one item and Live sessions chosen. */
export async function ownerEnters(page, { origin, base, tabTo, width }) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await expect(
    page.getByRole("button", { name: "Set up your own" }),
  ).toBeFocused();
  await sealOwner(page, tabTo);
  await expect(page.locator(".vault")).toBeVisible({ timeout: 30_000 });
  const create = page.getByRole("link", { name: "New item", exact: true });
  // A phone opens the vault on its section tree; Enter on it opens the list.
  if (width !== 1280) {
    await expect(page.locator(".railtree")).toBeFocused();
    await page.keyboard.press("Enter");
  }
  await expect(create).toBeFocused();
  await page.keyboard.press("Enter");
  await tabTo(page, page.getByLabel("Name", { exact: true }));
  await page.keyboard.press("ControlOrMeta+A");
  await page.keyboard.insertText("GitHub");
  await tabTo(
    page,
    page.getByRole("button", { name: "Save item", exact: true }),
  );
  await page.keyboard.press("Enter");
  await expect(page.locator("form.editor")).toHaveCount(0);
  await approveByKeyboard(page, tabTo, ["Live sessions"]);
}

/** Vault Share is available independently of the retired Settings panel. */
export async function openLive(page, tabTo) {
  await page.keyboard.press("Escape");
  await page.keyboard.press("g");
  await page.keyboard.press("v");
  await expect(page).toHaveURL(/\/vault(?:[/?].*)?$/, { timeout: 10_000 });
  const share = page
    .getByRole("button", {
      name: /^(Share this vault|Sharing — live session)$/,
    })
    .locator("visible=true");
  await expect(share).toBeVisible({ timeout: 20_000 });
  await tabTo(page, share);
  await page.keyboard.press("Enter");
  await expect(page.locator(SHARE_PANEL)).toBeVisible({ timeout: 20_000 });
}

/** Hosting belongs to an owned vault; guests cannot expose a Share key. */
async function sealOwner(page, tabTo) {
  await page.keyboard.press("Enter");
  await tabTo(
    page,
    page.getByRole("button", { name: "Skip all", exact: true }),
  );
  await page.keyboard.press("Enter");
  await tabTo(
    page,
    page.getByRole("button", { name: "Use without an account", exact: true }),
  );
  await page.keyboard.press("Enter");
  await tabTo(page, page.getByRole("tab", { name: "PIN", exact: true }));
  await page.keyboard.press("Enter");
  await expect(page.getByLabel("Device PIN", { exact: true })).toBeFocused();
  await page.keyboard.insertText("48291037");
  await tabTo(page, page.getByLabel("Confirm PIN", { exact: true }));
  await page.keyboard.insertText("48291037");
  const acknowledge = page.getByRole("checkbox");
  await tabTo(page, acknowledge);
  await page.keyboard.press("Space");
  await expect(acknowledge).toBeChecked();
  const seal = page.getByRole("button", { name: "Seal with PIN", exact: true });
  await expect(seal).toBeEnabled();
  await tabTo(page, seal);
  await page.keyboard.press("Enter");
}

/** The joining device creates its separate vault through the visible form. */
export async function sealJoiner(page, tabTo) {
  await tabTo(page, page.getByLabel("Your vault PIN", { exact: true }));
  await page.keyboard.insertText("73926584");
  await tabTo(page, page.getByLabel("Confirm PIN", { exact: true }));
  await page.keyboard.insertText("73926584");
  const acknowledge = page.getByRole("checkbox", {
    name: "I understand this vault cannot be recovered.",
    exact: true,
  });
  await tabTo(page, acknowledge);
  await page.keyboard.press("Space");
  await expect(acknowledge).toBeChecked();
}
