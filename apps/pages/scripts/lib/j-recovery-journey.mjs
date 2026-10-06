/**
 * J-RECOVERY: Settings › Security states that identity recovery does not
 * unwrap the vault key. The sentence sits with the keys it governs (Unlock
 * methods), so a fresh vault — which has no recovery codes and therefore no
 * Recovery panel (ADR 0158) — still says it.
 */
import { openSettingsCategory, sealWithPin } from "./pages-journey.mjs";

export async function walkJRecovery({ page, origin, base, check, snap }) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPin(page);
  await openSettingsCategory(page, "Security");
  await page.getByRole("heading", { name: "Unlock methods" }).waitFor({
    timeout: 15000,
  });
  const hint = await page
    .getByRole("heading", { name: "Unlock methods" })
    .locator("..")
    .innerText();
  check(
    /does not unwrap the vault/i.test(hint),
    "identity recovery copy refuses vault unwrap",
  );
  await snap(page, "J-RECOVERY-security");
}
