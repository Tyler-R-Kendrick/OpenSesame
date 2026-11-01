/** Every rendered catalog row gets a real browser walk, including explicit refusals. */
import { TOUCH_FLOOR } from "./mobile-contract.mjs";
import { nativeAiFormContract } from "./native-browser-ai-form-contract.mjs";
import {
  nativeAuthFieldObservation,
  nativeAuthFieldViolations,
} from "./native-browser-auth-field-contract.mjs";
import {
  NATIVE_CANONICAL_CATALOG_IDS,
  NATIVE_CANONICAL_PROVIDERS,
  NATIVE_SHARED_AI_PRESETS,
  nativeAuthFieldMethods,
  nativeCanonicalRouteProvider,
} from "./native-browser-catalog-projection.mjs";
import { addCapabilities } from "./pages-journey.mjs";

export async function nativeVisit(page, base, route) {
  await page.evaluate((href) => {
    history.pushState(null, "", href);
    dispatchEvent(new PopStateEvent("popstate"));
  }, `${base}${route}`);
}

export async function nativeEnableConnections(page, base) {
  await addCapabilities(page, ["External connectors"]);
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

/** A family tile's browse name is not the selected provider's route name. */
export function nativeCatalogRouteRow(row) {
  const provider = nativeCanonicalRouteProvider(row.id);
  return provider
    ? { ...row, id: provider.id, name: provider.name, catalogId: row.id }
    : row;
}

/**
 * A model provider's first connection from the Add catalog is a sheet over the
 * catalog, not a page (ADR 0192): the walk waits for whichever the route drew.
 */
async function nativeArrival(page, row) {
  const heading = page.getByRole("heading", { name: row.name, exact: true });
  const sheet = NATIVE_SHARED_AI_PRESETS.has(row.id)
    ? page
        .getByRole("dialog", { name: "Connect a model provider", exact: true })
        .getByRole("form", { name: "AI connection configuration", exact: true })
    : page.getByRole("form", { name: `Connect ${row.name}`, exact: true });
  await heading.or(sheet).first().waitFor();
  return (await sheet.count()) ? sheet : null;
}

/**
 * The sheet slides in from the edge and its fields settle after: measure it
 * once two reads, a frame apart, agree.
 */
async function nativeSheetLayout(page) {
  const read = () =>
    page.evaluate(() => {
      const sheetBox = document
        .querySelector('[role="dialog"]')
        ?.getBoundingClientRect();
      return {
        width: innerWidth,
        document: document.documentElement.scrollWidth,
        sheetRight: Math.round(sheetBox?.right ?? 0),
        keys: [
          ...document.querySelectorAll(
            '[role="dialog"] .icon-btn, [role="dialog"] input, [role="dialog"] select',
          ),
        ].map((node) => ({
          name: `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}`,
          height: Math.round(node.getBoundingClientRect().height * 100) / 100,
        })),
      };
    });
  let previous = JSON.stringify(await read());
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await page.waitForTimeout(100);
    const next = await read();
    if (JSON.stringify(next) === previous) return next;
    previous = JSON.stringify(next);
  }
  return read();
}

/** The Add sheet's own contract: what it asks for, what it never prefills, and that Close leaves it. */
async function nativeSheetContract(page, row, sheet, { check, phone }) {
  const dialog = page.getByRole("dialog", {
    name: "Connect a model provider",
    exact: true,
  });
  check(
    (await dialog.count()) === 1,
    `${row.id}: a model provider's first connection opens the Add sheet`,
  );
  check(
    await sheet
      .locator('input[type="password"]')
      .evaluateAll(
        (inputs) =>
          inputs.length > 0 && inputs.every((input) => input.value === ""),
      ),
    `${row.id}: the Add sheet asks for a key and prefills none`,
  );
  const labels = await sheet
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
    !labels.some((label) =>
      /Token endpoint|Authorization endpoint|Server URL|Client secret/i.test(
        label,
      ),
    ),
    `${row.id}: the Add sheet has no arbitrary endpoint or client-secret control`,
  );
  check(
    (await dialog.innerText()).includes("sealed on this device"),
    `${row.id}: the Add sheet says where the key is kept`,
  );
  const layout = await nativeSheetLayout(page);
  check(
    layout.document <= layout.width && layout.sheetRight <= layout.width,
    `${row.id}: the Add sheet has no horizontal overflow`,
  );
  if (phone) {
    // The mobile contract's own measure: a half pixel of rounding is not a miss.
    const under = layout.keys.filter((key) => key.height + 0.5 < TOUCH_FLOOR);
    check(
      under.length === 0,
      `${row.id}: the Add sheet's keys and fields meet the 44px phone floor${under.length ? ` (under: ${under.map((key) => `${key.name} ${key.height}`).join(", ")})` : ""}`,
    );
  }
  await dialog.getByRole("button", { name: "Close", exact: true }).click();
  await sheet.waitFor({ state: "detached" });
  check(
    new URL(page.url()).pathname.endsWith("/connections"),
    `${row.id}: closing the Add sheet returns to the catalog`,
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
    const observed = await nativeForm.evaluate(nativeAuthFieldObservation);
    const violations = nativeAuthFieldViolations(
      nativeAuthFieldMethods(row.id),
      observed,
    );
    check(
      violations.length === 0,
      `${row.id}: auth endpoint and client-secret controls belong only to the selected canonical method${violations.length ? ` (unexpected: ${violations.map((input) => input.label).join(", ")})` : ""}`,
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
      // A static card names why there is no browser road (a closed set of
      // reasons, `UNAVAILABLE_LABEL`), and "Desktop app required" only where a
      // native client really is the way in.
      harness.check(
        Boolean(row.capability),
        `${row.id}: static card names why it has no browser road without opening a fake configuration`,
      );
      continue;
    }
    const routeRow = nativeCatalogRouteRow(row);
    const url = new URL(row.href, `https://opensesame-labs.github.io${base}`);
    await nativeVisit(
      page,
      base,
      `${url.pathname.slice(base.length)}${url.search}${url.hash}`,
    );
    const sheet = await nativeArrival(page, routeRow);
    await nativePageContract(page, routeRow, { check: harness.check, phone });
    const preset = NATIVE_SHARED_AI_PRESETS.get(routeRow.id);
    if (preset)
      await nativeAiFormContract(page, routeRow, preset, {
        check: harness.check,
        record: harness.record,
        phone,
        base,
        sheet: Boolean(sheet),
        routePath: url.pathname,
      });
    if (sheet && !preset)
      await nativeSheetContract(page, routeRow, sheet, {
        check: harness.check,
        phone,
      });
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
    const preset = NATIVE_SHARED_AI_PRESETS.get(row.id);
    if (preset)
      await nativeAiFormContract(page, row, preset, {
        check: harness.check,
        record: harness.record,
        phone,
        base,
        sheet: false,
        routePath: `${base}settings/connections/${encodeURIComponent(row.id)}`,
      });
  }
  harness.check(
    true,
    `reviewed ${NATIVE_CANONICAL_PROVIDERS.length} canonical provider identities across catalog and Settings routes`,
  );
  return rows;
}
