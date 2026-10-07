/**
 * A vault sealed under a master password by the store, not by a screen (ADR
 * 0180): the way a walk gets a wrap that travels to a second device. The
 * fixture runs in a disposable page of the device's own origin, so the vault
 * lands in that device's real encrypted storage and the app finds it locked.
 */
import { fileURLToPath } from "node:url";
import { bundle } from "./local-iam-rig.mjs";
import { waitOpen } from "./pages-journey.mjs";

export const SEEDED_PASSWORD = "Cedar-lantern-47-river!";

let fixture = null;

/** Seal a password vault on the device `context` belongs to, then close the page. */
export async function seedPasswordVault(context, origin) {
  fixture ??= await bundle(
    fileURLToPath(new URL("../fixtures/vault-seed.ts", import.meta.url)),
    "VaultSeedFixture",
  );
  await context.route(`${origin}/fixture`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: "<!doctype html><html><body>Disposable vault fixture</body></html>",
    }),
  );
  const page = await context.newPage();
  await page.goto(`${origin}/fixture`);
  await page.addScriptTag({ content: fixture });
  await page.evaluate(
    (password) => VaultSeedFixture.seed(password),
    SEEDED_PASSWORD,
  );
  await page.close();
}

/** Unlock a vault that holds a master password, from its unlock screen. */
export async function unlockSeeded(page) {
  await page.getByLabel("Password", { exact: true }).fill(SEEDED_PASSWORD);
  await page.getByRole("button", { name: "Unlock", exact: true }).click();
  await waitOpen(page);
}
