import { expect } from "@playwright/test";

const BASE = "https://tyler-r-kendrick.github.io/OpenSesame";

/** Every load locks the vault, and these suites load more than once. */
export async function unlockVault(page, password = "Cedar-lantern-47-river!") {
  const field = page.getByLabel("Password", { exact: true });
  await expect(field).toBeVisible();
  await field.fill(password);
  await field.press("Enter");
}

/**
 * Choose capabilities on a seeded installation, by URL and through the real
 * Add and Apply.
 *
 * The sections and the consent screen this suite drives belong to
 * capabilities, and a device that has not chosen one has no such route to
 * land on (ADR 0130). A fixture cannot write the choice — a consent receipt
 * binds exposure digests and a forged one is refused — so it goes through
 * the UI. By URL rather than the rail, because this runs at 390 too, where
 * the rail lives behind the Sections drawer; and unlocking after every load,
 * because every load locks the vault. Idempotent: a row that offers no Add
 * is already approved, arrived as a dependency, or is not in this
 * distribution.
 */
export async function chooseCapabilities(context, width, titles, base = BASE) {
  const page = await context.newPage();
  await page.setViewportSize({ width, height: 900 });
  for (const title of titles) {
    await page.goto(`${base}/settings/capabilities`);
    await unlockVault(page);
    await expect(page.getByTestId("capabilities-panel")).toBeVisible();
    const add = page.getByRole("button", { name: `Add ${title}`, exact: true });
    if ((await add.count()) > 0) {
      await add.click();
      const apply = page.getByTestId("capability-apply");
      await expect(apply).toBeEnabled();
      await apply.click();
      await expect(page.getByTestId("capability-review")).toHaveCount(0, {
        timeout: 20_000,
      });
    }
    // Assert the postcondition, and say what the panel said when it fails:
    // a helper that skips silently reports success for a walk that then
    // fails somewhere else entirely, which is how this took a while to
    // find. A row that still offers Add did not take; one that is running
    // offers Disable instead.
    const row = page.locator(".capspanel__row").filter({ hasText: title });
    const notice = page.locator(".capspanel__notice");
    const state = `${await row.first().innerText()} — ${
      (await notice.count()) ? await notice.first().innerText() : "no notice"
    }`;
    expect(
      await page
        .getByRole("button", { name: `Add ${title}`, exact: true })
        .count(),
      `${title} was not taken: ${state}`,
    ).toBe(0);
    expect(
      await page
        .getByRole("button", { name: `Disable ${title} now`, exact: true })
        .count(),
      `${title} is not running: ${state}`,
    ).toBe(1);
  }
  await page.close();
}
