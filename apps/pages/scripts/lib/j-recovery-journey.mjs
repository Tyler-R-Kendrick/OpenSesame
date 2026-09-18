/**
 * J-RECOVERY: Settings › Security states that identity recovery does not
 * unwrap the vault key.
 */
import { openSettingsCategory, sealWithPassword } from "./pages-journey.mjs";

export async function walkJRecovery({ page, origin, base, check, snap }) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPassword(page);
  await openSettingsCategory(page, "Security");
  await page.getByRole("heading", { name: "Recovery" }).waitFor({
    timeout: 15000,
  });
  const hint = await page
    .getByRole("heading", { name: "Recovery" })
    .locator("..")
    .innerText();
  check(
    /does not unwrap the vault/i.test(hint),
    "identity recovery copy refuses vault unwrap",
  );
  await snap(page, "J-RECOVERY-security");
}
