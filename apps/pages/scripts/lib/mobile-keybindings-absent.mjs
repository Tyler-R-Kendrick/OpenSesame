/**
 * Settings › Keybindings is absent on a touch-only device (DESIGN.md § Touch):
 * no key to press means nothing to bind. The phone context is coarse with no
 * fine pointer, so the strip, the rail's settings tree and the page index
 * carry no link to it, and its address lands on General.
 */

/** Every link on the page that names the key editor, by label or address. */
const KEYBINDINGS_LINKS = `(() =>
  [...document.querySelectorAll("a")]
    .filter(
      (link) =>
        /\\/settings\\/keybindings/.test(link.getAttribute("href") ?? "") ||
        (link.textContent ?? "").trim() === "Keybindings",
    )
    .map((link) => link.getAttribute("href") ?? link.textContent))()`;

export async function auditKeybindingsAbsent(page, harness, stop) {
  const label = stop("settings-keybindings-absent");
  const fine = await page.evaluate("matchMedia('(any-pointer: fine)').matches");
  harness.check(!fine, `${label}: the context has no fine pointer`);
  const tabs = await page.evaluate(
    `[...document.querySelectorAll('nav[aria-label="Settings sections"] a')].map((link) => link.textContent.trim())`,
  );
  harness.check(
    tabs.includes("General") && !tabs.includes("Keybindings"),
    `${label}: the tab strip lists ${tabs.join(", ")}, no Keybindings`,
  );
  const links = await page.evaluate(KEYBINDINGS_LINKS);
  harness.check(
    links.length === 0,
    `${label}: no link to the key editor anywhere on the page (saw ${links.join(", ") || "none"})`,
  );
  await page.evaluate(() => {
    history.pushState(
      null,
      "",
      `${location.pathname.replace(/settings.*$/, "")}settings/keybindings`,
    );
    dispatchEvent(new PopStateEvent("popstate"));
  });
  await page.waitForTimeout(600);
  const landed = await page.evaluate("location.pathname");
  harness.check(
    /\/settings\/?$/.test(landed),
    `${label}: /settings/keybindings lands on /settings (at ${landed})`,
  );
}
