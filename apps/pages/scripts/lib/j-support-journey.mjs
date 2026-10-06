/**
 * J-SUPPORT: with no model ready the Support sheet searches the written help.
 * The field stays enabled, the key says Search, and the sheet does not explain
 * the missing model. Untrusted text may propose a draft but never name a
 * mutation tool (ADV-10); that gate is held at the enforcement boundary with
 * these exact strings in `lib/configuration/experience-journeys.test.ts`.
 */
import { addCapabilities, sealWithPin } from "./pages-journey.mjs";

export async function walkJSupport({ page, origin, base, check, snap }) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPin(page);
  // The support panel is contributed by `support.guided-help`: choose it
  // before its key exists (ADR 0130).
  await addCapabilities(page, ["Guided help"]);
  await page.getByRole("button", { name: /^Support/ }).click();
  const sheet = page.getByRole("dialog", { name: "Support" });
  await sheet.waitFor({ timeout: 15000 });
  const search = sheet.getByLabel("Search the written help");
  await search.waitFor({ timeout: 8000 });
  check(
    !(await search.isDisabled()),
    "search over the written help stays available",
  );
  check(
    (await sheet
      .getByRole("button", { name: "Search", exact: true })
      .count()) === 1,
    "the key says Search",
  );
  check(
    (await sheet.getByRole("button").count()) > 1,
    "the written help below still works",
  );
  const prose = await sheet.innerText();
  check(
    !/on-device model|support endpoint/i.test(prose),
    "the sheet does not explain the missing model",
  );
  await snap(page, "J-SUPPORT-no-model");
}
