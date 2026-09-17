/**
 * J-HOST-CONFIG (static / no Host session): Project configs has no REST
 * snippet dead-end; without Host access the panel fails closed.
 */
import { openSettingsCategory, sealWithPassword } from "./pages-journey.mjs";

export async function walkJHostConfig({ page, origin, base, check, snap }) {
  await page.goto(`${origin}${base}`, { waitUntil: "networkidle" });
  await sealWithPassword(page);
  await openSettingsCategory(page, "Connectivity");
  await page
    .getByRole("heading", { name: "Project configs" })
    .waitFor({ timeout: 15000 });
  const body = await page.locator("body").innerText();
  check(
    !/POST\s+\/api\/v1\/projects/i.test(body),
    "no Host POST snippet dead-end",
  );
  await page.getByLabel("Project id").fill("project_demo");
  await page.waitForTimeout(600);
  const after = await page.locator("body").innerText();
  const honest =
    /not shared with this role/i.test(after) ||
    /Could not load|Host|setup_required|Offline/i.test(after) ||
    /Create config/i.test(after);
  check(honest, "panel fails closed or offers Create without inventing access");
  check(
    !/POST\s+\/api\/v1\/projects/i.test(after),
    "Create path still has no REST snippet",
  );
  await snap(page, "J-HOST-CONFIG-connectivity");
}
