/**
 * J-SUPPORT: before any model runs the Support sheet refuses proposals —
 * nothing can answer, so it says so in prose, keeps the field disabled for
 * assistive technology, and the written help below still works. Untrusted text
 * may propose a draft but never name a mutation tool (ADV-10); that gate is
 * held at the enforcement boundary with these exact strings in
 * `lib/configuration/experience-journeys.test.ts`.
 */
import { sealWithPassword } from "./pages-journey.mjs";

export async function walkJSupport({ page, origin, base, check, snap }) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPassword(page);
  await page.getByRole("button", { name: /^Support/ }).click();
  const sheet = page.getByRole("dialog", { name: "Support" });
  await sheet.waitFor({ timeout: 15000 });
  const prose = await sheet.innerText();
  check(
    /on-device model|support endpoint|nothing is available|offline|not been downloaded/i.test(
      prose,
    ),
    `the sheet names the unavailable state in prose: ${prose.slice(0, 120)}`,
  );
  const ask = sheet.getByLabel("Ask about this screen");
  await ask.waitFor({ timeout: 8000 });
  check(
    await ask.isDisabled(),
    "the field that cannot work is disabled for assistive technology",
  );
  check(
    (await sheet.getByRole("button").count()) > 1,
    "the written help below still works",
  );
  await snap(page, "J-SUPPORT-no-model");
}
