/**
 * The owner's transport profile as a file, the road a person takes when the
 * Routes Form has no field for what they mean to say (ADR 0134, ADR 0150 §6):
 * `settings/live/transport.json`, opened from the key on the Routes heading,
 * typed into the file viewer's editor, saved with its save key and read back
 * by opening it again. A TURN server's REST `secret` is written only here —
 * the Form has no secret field, by design.
 */

import { expect } from "@playwright/test";
import { openSettingsCategory } from "./pages-journey.mjs";

export const PROFILE_PATH = "settings/live/transport.json";

/**
 * Open the profile from Routes. The directory's `config.yaml` is the designed
 * page (ADR 0134); the file a provider keeps for authoring opens in the viewer
 * from the key on the heading of the Form drawn from it.
 */
async function openProfileFile(page) {
  await openSettingsCategory(page, "Live sessions");
  const routes = page.locator("#live-routes");
  await routes.waitFor({ timeout: 20_000 });
  await routes.getByRole("button", { name: "Open transport.json" }).click();
  const field = page.getByRole("textbox", { name: PROFILE_PATH, exact: true });
  await field.waitFor({ timeout: 10_000 });
  return field;
}

/** Type the profile into its file and save it; resolves once the save says so. */
export async function saveProfileFile(page, profile) {
  const field = await openProfileFile(page);
  await field.fill(JSON.stringify(profile, null, 2));
  await page.getByRole("button", { name: `Save ${PROFILE_PATH}` }).click();
  await page
    .locator("output", { hasText: `Saved ${PROFILE_PATH}.` })
    .waitFor({ state: "attached", timeout: 10_000 });
}

/** The profile as the file now holds it, opened afresh (once its text has loaded). */
export async function readProfileFile(page) {
  const field = await openProfileFile(page);
  await expect(field).not.toHaveValue("", { timeout: 10_000 });
  return JSON.parse(await field.inputValue());
}

/** The routes a session link carries (its fifth segment), or null for none. */
export function linkRoutes(link) {
  const live = new URLSearchParams(new URL(link).hash.slice(1)).get("live");
  const segment = (live ?? "").split(".")[4];
  return segment
    ? JSON.parse(Buffer.from(segment, "base64url").toString("utf8"))
    : null;
}

/** Back from the file to the Form it spells (Back returns to the form). */
export async function backToForm(page) {
  await page
    .locator(".set__nav")
    .getByRole("link", { name: "Live sessions", exact: true })
    .click();
  const routes = page.locator("#live-routes");
  await routes.waitFor({ timeout: 20_000 });
  return routes;
}
