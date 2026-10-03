/**
 * The `tab` verb: open one of the app's sections by name, and the route a
 * journey may name for a deployment's own `os-runtime-config.json`.
 * `press` is `capture-evidence.mjs`'s tap-or-click; `visit` follows an
 * in-app route.
 */

export function tabStep({ press, visit }) {
  return {
    async tab(page, name) {
      // A phone keeps its sections behind one key; a desktop has the rail.
      const key = page.getByRole("button", { name: "Sections" }).first();
      if (await key.count()) {
        await press(key);
        await page.waitForTimeout(450);
        await press(page.locator(".drawer__row", { hasText: name }).first());
      } else {
        const row = page.locator(".railtree__row", { hasText: name }).first();
        // A rail that draws only the vault's branch has no row for a
        // section: it is reached by its route, as a typed address would.
        if (await row.count()) await press(row);
        else await visit(page, name.toLowerCase());
      }
      await page.waitForTimeout(900);
    },
  };
}

/**
 * Serve `config` as the deployment's `os-runtime-config.json` for one page:
 * what an operator's policy changes about a screen. Registered after the
 * harness's own route, so it answers first.
 */
export async function serveRuntimeConfig(context, { origin, base, config }) {
  await context.route(`${origin}${base}os-runtime-config.json`, (route) =>
    route.fulfill({
      status: 200,
      headers: { "content-type": "application/json" },
      body: JSON.stringify(config),
    }),
  );
}
