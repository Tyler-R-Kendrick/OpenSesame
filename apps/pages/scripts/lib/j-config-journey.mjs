/**
 * J-CONFIG against the built Pages dist: the page → a night theme and
 * clipboardClearSeconds 30 → the same values on settings/general/config.yaml's
 * page → lock → unlock → reload. The file is the page, so there is one place to
 * set a value and one to see it.
 * Uses a password-sealed vault so lock/unlock is the same tomb (guest
 * isolation would open a different store).
 */
import {
  lockVault,
  openConfigFile,
  openGeneral,
  sealWithPassword,
  unlockWithPassword,
} from "./pages-journey.mjs";

async function assertValues(page, check, label) {
  await openGeneral(page);
  const clipboard = page.getByLabel("Clear copied secrets after");
  await clipboard.waitFor({ timeout: 8000 });
  check((await clipboard.inputValue()) === "30", `${label}: clipboard is 30`);
  check(
    (await page
      .getByRole("button", { name: "Night" })
      .getAttribute("aria-pressed")) === "true",
    `${label}: theme is Night`,
  );
  // The file's address draws the same page with the same values.
  await openConfigFile(page, "general");
  const same = page.getByLabel("Clear copied secrets after");
  await same.waitFor({ timeout: 8000 });
  check(
    (await same.inputValue()) === "30",
    `${label}: config.yaml's page shows clipboard 30`,
  );
}

export async function walkJConfig({ page, origin, base, check, snap }) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPassword(page);
  await openGeneral(page);
  await snap(page, "J-CONFIG-form");
  await page.getByRole("button", { name: "Night" }).click();
  const clipboard = page.getByLabel("Clear copied secrets after");
  await clipboard.selectOption("30");
  await page.waitForTimeout(400);
  check((await clipboard.inputValue()) === "30", "the form holds clipboard 30");
  await snap(page, "J-CONFIG-form-30");
  await openConfigFile(page, "general");
  check(
    (await page.getByLabel("Clear copied secrets after").inputValue()) === "30",
    "config.yaml's page shows clipboard 30",
  );
  await lockVault(page);
  await unlockWithPassword(page);
  await assertValues(page, check, "after unlock");
  await snap(page, "J-CONFIG-after-unlock");
  await page.reload({ waitUntil: "networkidle" });
  await page
    .getByLabel("Password", { exact: true })
    .waitFor({ timeout: 15000 });
  await unlockWithPassword(page);
  await assertValues(page, check, "after reload");
  await snap(page, "J-CONFIG-after-reload");
}
