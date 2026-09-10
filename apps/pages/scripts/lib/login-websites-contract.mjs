import { expect } from "@playwright/test";

export async function checkLoginWebsites(page, check) {
  const viewport = page.viewportSize();
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 800 });
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
    ).toHaveText("match");
    await page
      .getByLabel("Test website", { exact: true })
      .fill("https://app.example.com.evil.test");
    await page.getByRole("button", { name: "Test match", exact: true }).click();
    await expect(
      page.locator("form.editor output[aria-live=polite]"),
    ).toHaveText("no-match");
    await rule.selectOption("regex");
    await address.fill("(.*\\.)?example\\.com");
    await page
      .getByLabel("Test website", { exact: true })
      .fill("https://example.com");
    await page.getByRole("button", { name: "Test match", exact: true }).click();
    await expect(
      page.locator("form.editor output[aria-live=polite]"),
    ).toHaveText("match");
    await address.fill("(a+)+");
    await page
      .getByLabel("Test website", { exact: true })
      .fill(`https://${"a".repeat(60)}b.test`);
    await page.getByRole("button", { name: "Test match", exact: true }).click();
    await expect(
      page.locator("form.editor output[aria-live=polite]"),
    ).toHaveText("timeout");
    await address.fill("[");
    await page.getByLabel("Name", { exact: true }).fill("Pattern fixture");
    await page.getByRole("button", { name: "Save item", exact: true }).click();
    await expect(page.getByRole("alert")).toContainText("invalid");
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
