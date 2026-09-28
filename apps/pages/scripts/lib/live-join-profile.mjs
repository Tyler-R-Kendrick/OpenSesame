/**
 * The owner's transport profile as a file, the road a person takes when the
 * Routes Form has no field for what they mean to say (ADR 0134, ADR 0150 §6):
 * `settings/live/transport.json`, opened from the command bar,
 * typed into the file viewer's editor, saved with its save key and read back
 * by opening it again. A TURN server's REST `secret` is written only here —
 * the Form has no secret field, by design.
 */

import { runCommand } from "./pages-journey.mjs";

export const PROFILE_PATH = "settings/live/transport.json";

/**
 * Open the profile: the command bar opens the directory's document, and
 * Live sessions keeps nothing but this file there, so the file is what opens.
 */
async function openProfileFile(page) {
  const opened = await runCommand(page, "settings/live/config.yaml");
  if (!/Opened/i.test(opened))
    throw new Error(`${PROFILE_PATH} did not open: ${opened}`);
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

/** The profile as the file now holds it, opened afresh. */
export async function readProfileFile(page) {
  const field = await openProfileFile(page);
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
