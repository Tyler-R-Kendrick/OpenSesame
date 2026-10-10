/** Every rendered catalog row gets a real browser walk, including explicit refusals. */
import {
  NATIVE_CANONICAL_CATALOG_IDS,
  NATIVE_CANONICAL_PROVIDERS,
} from "./native-browser-catalog-projection.mjs";

export async function nativeVisit(page, base, route) {
  await page.evaluate((href) => {
    history.pushState(null, "", href);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}${route}`);
}

export async function nativeEnableConnections(page, base) {
  await nativeVisit(page, base, "settings/capabilities");
  const toggle = page.getByRole("switch", { name: "Connections", exact: true });
  await toggle.waitFor();
  if ((await toggle.getAttribute("aria-checked")) !== "true")
    await toggle.click();
  await nativeVisit(page, base, "connections#catalog");
  await page
    .getByRole("heading", { name: "Add a connection", exact: true })
    .waitFor();
}

async function catalogRows(page) {
  return page.locator("#catalog .conn-tile").evaluateAll((tiles) =>
    tiles.map((tile) => ({
      id: decodeURIComponent(tile.id.replace(/^catalog-/, "")),
      name: tile.querySelector(".conn-tile__name")?.textContent ?? "",
      href: tile.querySelector("a")?.getAttribute("href") ?? null,
      capability:
        tile.querySelector(".conn-tile__link")?.getAttribute("title") ?? null,
    })),
  );
}

async function nativePageContract(page, row, { check, phone }) {
  const main = await page.locator("main").innerText();
  if (row.id !== "vercel")
    check(
      !/Vercel Connect|Vercel access token|Vercel tokens/.test(main),
      `${row.id}: no inherited hosted configuration`,
    );
  check(
    !/Connector not found/.test(main),
    `${row.id}: selected catalog connector has a real page`,
  );
  if (row.id !== "linear")
    check(
      !/Linear API key|Linear workspace|Linear OAuth client/.test(main),
      `${row.id}: no copied Linear information`,
    );
  const nativeForm = page.getByRole("group", {
    name: `${row.name} configuration`,
    exact: true,
  });
  if (await nativeForm.count()) {
    check(
      await nativeForm
        .locator('input[type="password"]')
        .evaluateAll((inputs) => inputs.every((input) => input.value === "")),
      `${row.id}: no sealed secret prefilled`,
    );
    const editable = await nativeForm
      .locator("input")
      .evaluateAll((inputs) =>
        inputs
          .filter((input) => !input.readOnly)
          .map(
            (input) =>
              document.querySelector(`label[for="${CSS.escape(input.id)}"]`)
                ?.textContent ?? "",
          ),
      );
    check(
      !editable.some((label) =>
        /Token endpoint|Authorization endpoint|Server URL|Client secret/i.test(
          label,
        ),
      ),
      `${row.id}: no arbitrary auth endpoint or confidential client-secret control`,
    );
  }
  const layout = await page.evaluate(() => ({
    width: innerWidth,
    document: document.documentElement.scrollWidth,
    modes: [...document.querySelectorAll(".cx-mode")].map(
      (node) => node.getBoundingClientRect().height,
    ),
  }));
  check(
    layout.document <= layout.width,
    `${row.id}: connector page has no horizontal overflow`,
  );
  if (phone)
    check(
      layout.modes.every((height) => height >= 44),
      `${row.id}: method controls meet the 44px phone floor`,
    );
}

export async function nativeCatalogJourney(
  page,
  harness,
  { base, phone = false },
) {
  await nativeVisit(page, base, "connections#catalog");
  await page
    .getByRole("heading", { name: "Add a connection", exact: true })
    .waitFor();
  await page.locator("#catalog .conn-tile").first().waitFor();
  const rows = await catalogRows(page);
  harness.check(
    JSON.stringify(rows.map((row) => row.id).sort()) ===
      JSON.stringify([...NATIVE_CANONICAL_CATALOG_IDS].sort()),
    `catalog covers all ${NATIVE_CANONICAL_CATALOG_IDS.length} canonical visible provider IDs`,
  );
  harness.check(
    new Set(rows.map((row) => row.id)).size === rows.length,
    "catalog has no duplicated provider IDs",
  );
  for (const row of rows) {
    harness.setStep(`${phone ? "phone" : "desktop"}-catalog-${row.id}`);
    if (!row.href) {
      harness.check(
        ["Desktop app required", "Unavailable"].includes(row.capability),
        `${row.id}: static card explicitly indicates actual runtime capability without opening a fake configuration`,
      );
      continue;
    }
    const url = new URL(row.href, `https://tyler-r-kendrick.github.io${base}`);
    await nativeVisit(
      page,
      base,
      `${url.pathname.slice(base.length)}${url.search}${url.hash}`,
    );
    await page.getByRole("heading", { name: row.name, exact: true }).waitFor();
    await nativePageContract(page, row, { check: harness.check, phone });
  }
  const listed = new Set(rows.map((row) => row.id));
  for (const row of NATIVE_CANONICAL_PROVIDERS) {
    if (listed.has(row.id)) continue;
    harness.setStep(
      `${phone ? "phone" : "desktop"}-settings-provider-${row.id}`,
    );
    await nativeVisit(
      page,
      base,
      `settings/connections/${encodeURIComponent(row.id)}`,
    );
    await page.getByRole("heading", { name: row.name, exact: true }).waitFor();
    await nativePageContract(page, row, { check: harness.check, phone });
  }
  harness.check(
    true,
    `reviewed ${NATIVE_CANONICAL_PROVIDERS.length} canonical provider identities across catalog and Settings routes`,
  );
  return rows;
}
