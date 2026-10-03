// Login pages as a person meets them: opened, then a field focused.

/** Open `path` on `host` (a `*.test` name) and collect what the page throws. */
export async function openLogin(
  session,
  path,
  { host = "app.test", focus } = {},
) {
  const page = await session.context.newPage();
  page.errors = [];
  page.on("pageerror", (error) => page.errors.push(error.message));
  await page.goto(`${session.sites.origin(host)}${path}`);
  if (focus) await page.locator(focus).focus();
  return page;
}

/** The value a field holds now. */
export const fieldValue = (page, selector) =>
  page.locator(selector).inputValue();

/** A frame of `page` by its `<iframe>` element's id. */
export async function frameOf(page, iframeId) {
  const handle = await page.locator(`#${iframeId}`).elementHandle();
  const frame = await handle?.contentFrame();
  if (!frame) throw new Error(`no frame behind #${iframeId}`);
  await frame.waitForLoadState("domcontentloaded");
  return frame;
}

/**
 * Everything the page's own script can read, searched for `needle`: every
 * string reachable as a property of `window` (one level), the DOM as markup,
 * cookies, both Web Storage areas, history state and the resource timeline.
 * Returns where it was found, or an empty list.
 */
export function pageSees(page, needle) {
  return page.evaluate((text) => {
    const found = [];
    const look = (where, value) => {
      let flat;
      try {
        flat = JSON.stringify(value) ?? "";
      } catch {
        flat = "";
      }
      if (flat.includes(text)) found.push(where);
    };
    for (const name of Object.getOwnPropertyNames(window)) {
      let value;
      try {
        value = window[name];
      } catch {
        continue;
      }
      if (!(value instanceof Function)) look(`window.${name}`, value);
    }
    look("markup", document.documentElement.outerHTML);
    look("cookie", document.cookie);
    look("localStorage", { ...localStorage });
    look("sessionStorage", { ...sessionStorage });
    look("history.state", history.state);
    look(
      "resources",
      performance.getEntries().map((entry) => entry.name),
    );
    return found;
  }, needle);
}
