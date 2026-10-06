import { expect } from "@playwright/test";
import { toTheList } from "./phone-vault.mjs";
import { expectInTray } from "./tray-contract.mjs";

// A loaded CI runner shares its cores with the other gates: the match worker
// has answered in well under a second on a quiet one and missed 5 s on a busy one.
const MATCH_WAIT_MS = 20_000;

export async function checkAccountWebsites(page, check) {
  const viewport = page.viewportSize();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
    await toTheList(page);
    await page.getByRole("link", { name: "New item", exact: true }).click();
    await page
      .getByRole("button", { name: "Add address", exact: true })
      .click();
    const address = page.getByLabel("Address 1", { exact: true });
    const rule = page.getByLabel("Match rule 1", { exact: true });
    await rule.selectOption("wildcard");
    await address.fill("*.example.com");
    const geometry = await address.evaluate((node) => ({
      before:
        node.getBoundingClientRect().bottom <=
        document.getElementById("username").getBoundingClientRect().top,
      overflow: document.documentElement.scrollWidth > innerWidth,
    }));
    check(
      geometry.before && !geometry.overflow,
      `Websites precedes Username without overflow at ${width}px`,
    );
    await page
      .getByLabel("Test website", { exact: true })
      .fill("https://app.example.com/login");
    await page.getByRole("button", { name: "Test match", exact: true }).click();
    await expect(
      page.locator("form.editor output[aria-live=polite]"),
    ).toHaveText("match", { timeout: MATCH_WAIT_MS });
    await page
      .getByLabel("Test website", { exact: true })
      .fill("https://app.example.com.evil.test");
    await page.getByRole("button", { name: "Test match", exact: true }).click();
    await expect(
      page.locator("form.editor output[aria-live=polite]"),
    ).toHaveText("no-match", { timeout: MATCH_WAIT_MS });
    await rule.selectOption("regex");
    await address.fill("(.*\\.)?example\\.com");
    await page
      .getByLabel("Test website", { exact: true })
      .fill("https://example.com");
    await page.getByRole("button", { name: "Test match", exact: true }).click();
    await expect(
      page.locator("form.editor output[aria-live=polite]"),
    ).toHaveText("match", { timeout: MATCH_WAIT_MS });
    await address.fill("(a+)+");
    await page
      .getByLabel("Test website", { exact: true })
      .fill(`https://${"a".repeat(60)}b.test`);
    await page.getByRole("button", { name: "Test match", exact: true }).click();
    await expect(
      page.locator("form.editor output[aria-live=polite]"),
    ).toHaveText("timeout", { timeout: MATCH_WAIT_MS });
    await address.fill("[");
    await page.getByLabel("Name", { exact: true }).fill("Pattern fixture");
    await page.getByRole("button", { name: "Save item", exact: true }).click();
    await expectInTray(page, "invalid");
    await address.fill("(.*\\.)?example\\.com");
    await page.getByRole("button", { name: "Save item", exact: true }).click();
    await expect(
      page.getByRole("link", { name: "Cancel", exact: true }),
    ).toHaveCount(0);
    await expect(
      page.getByRole("heading", { name: "Pattern fixture", exact: true }),
    ).toBeVisible();
    await page.goBack();
    await page.getByRole("link", { name: "Cancel", exact: true }).click();
    check(
      true,
      `Wildcard, regex, lookalike rejection, timeout and save validation work at ${width}px`,
    );
    await expect(
      page.getByRole("link", { name: "New item", exact: true }),
    ).toBeVisible();
  }
  if (viewport) await page.setViewportSize(viewport);
}
