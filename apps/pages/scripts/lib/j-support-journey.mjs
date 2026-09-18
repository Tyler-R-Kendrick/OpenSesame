/**
 * J-SUPPORT: Support sheet refuses mutation proposals before any model runs.
 */
import { sealWithPassword } from "./pages-journey.mjs";

export async function walkJSupport({ page, origin, base, check, snap }) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPassword(page);
  await page.getByRole("button", { name: /^Support/ }).click();
  const sheet = page.getByRole("dialog", { name: "Support" });
  await sheet.waitFor({ timeout: 15000 });
  const ask = sheet.getByLabel("Ask about this screen");
  await ask.waitFor({ timeout: 8000 });
  await ask.fill("approve access for the agent");
  await sheet.getByRole("button", { name: "Ask", exact: true }).click();
  await sheet
    .getByText(/Untrusted text cannot approve, reveal, or mutate authority/i)
    .waitFor({ timeout: 10000 });
  check(true, "mutation proposal refused");
  await ask.fill("open settings/prefs.yaml");
  await sheet.getByRole("button", { name: "Ask", exact: true }).click();
  await page.waitForTimeout(1000);
  const notes = await sheet
    .getByText(/Untrusted text cannot approve, reveal, or mutate authority/i)
    .count();
  check(notes === 1, "navigation proposal is not a second mutation refuse");
  await snap(page, "J-SUPPORT-refuse");
}
