/**
 * The small things that make a phone screen read as made: the pieces that were
 * each measured by eye until they were measured here. Every check reads
 * computed geometry in the touch context the walk already runs in.
 */

/** Header controls stay inside the bar without overlapping the section name. */
export async function topbarPromptFits(page, stop, { harness }) {
  const fit = await page.evaluate(() => {
    const prompt = document.querySelector(".topbar");
    const lock = prompt?.querySelector('[aria-label="Lock vault"]');
    if (!prompt || !lock) return null;
    const p = prompt.getBoundingClientRect();
    const k = lock.getBoundingClientRect();
    const names = [...prompt.children]
      .filter(
        (n) =>
          n.getBoundingClientRect().width > 0 && !n.matches(".sheet-layer"),
      )
      .map((n) => {
        const r = n.getBoundingClientRect();
        return { right: r.right, left: r.left };
      });
    const overlap = names.some(
      (n, i) => i > 0 && n.left < names[i - 1].right - 0.5,
    );
    return { keyRight: k.right, promptRight: p.right, overlap, vw: innerWidth };
  });
  harness.check(
    fit !== null,
    `${stop("topbar-prompt")}: the header and lock are on screen`,
  );
  if (!fit) return;
  harness.check(
    fit.keyRight <= fit.promptRight + 0.5 && fit.keyRight <= fit.vw,
    `${stop("topbar-prompt")}: the lock key is whole inside the bar (${Math.round(fit.keyRight)} <= ${Math.round(fit.promptRight)})`,
  );
  harness.check(
    !fit.overlap,
    `${stop("topbar-prompt")}: the header controls and section name do not overlap`,
  );
}

/**
 * Every switch is drawn inside a 44px key whose track sits at its centre, and
 * the switches of one panel share an edge. A button's own side padding once
 * pushed the track 5px right of the knob's anchor, and a section's switch sat a
 * tile's inset to the right of its tiles' switches.
 */
export async function switchesAligned(page, stop, { harness }) {
  const res = await page.evaluate(() => {
    const switches = [
      ...document.querySelectorAll(".capsections .toggle"),
    ].filter((n) => n.getBoundingClientRect().width > 0);
    if (switches.length === 0) return null;
    const padded = switches.filter((n) => {
      const cs = getComputedStyle(n);
      return cs.paddingLeft !== "0px" || cs.paddingRight !== "0px";
    }).length;
    const rights = [
      ...new Set(
        switches.map((n) => Math.round(n.getBoundingClientRect().right)),
      ),
    ];
    // Tiles in more than one column (a landscape phone) have more than one edge.
    const columns = new Set(
      [...document.querySelectorAll(".capsection__cap")].map((n) =>
        Math.round(n.getBoundingClientRect().left),
      ),
    ).size;
    return { count: switches.length, padded, rights, columns };
  });
  if (!res) return;
  harness.check(
    res.padded === 0,
    `${stop("switches")}: no switch carries side padding (${res.padded} of ${res.count} do)`,
  );
  harness.check(
    res.columns > 1 || res.rights.length === 1,
    `${stop("switches")}: section and tile switches share one right edge (${res.rights.join(", ")})`,
  );
}

/** A listing's search key is the bare icon key its neighbours are. */
export async function searchKeysBare(page, stop, { harness }) {
  const boxed = await page.evaluate(
    () =>
      [...document.querySelectorAll(".vtree__key:not(.vtree__key--help)")]
        .filter((n) => n.getBoundingClientRect().width > 0)
        .filter((n) => {
          const cs = getComputedStyle(n);
          return (
            cs.borderTopColor !== "rgba(0, 0, 0, 0)" ||
            cs.backgroundColor !== "rgba(0, 0, 0, 0)"
          );
        }).length,
  );
  harness.check(
    boxed === 0,
    `${stop("search-key")}: the search key is drawn bare, like the keys beside it (${boxed} boxed)`,
  );
}

/**
 * An account's password keys (update, reveal, copy) share one line. The minimal
 * vault's own kind has no password, so the check saves an account to look at.
 */
export async function passwordKeysOneLine(page, stop, { harness, base }) {
  await page.evaluate((b) => {
    history.pushState({}, "", `${b}vault/new/account`);
    dispatchEvent(new PopStateEvent("popstate"));
  }, base);
  await page.waitForTimeout(900);
  const name = page.getByLabel("Name", { exact: true });
  if ((await name.count()) === 0) return;
  await name.fill("Polish check");
  await page
    .getByRole("button", { name: "Save item", exact: true })
    .first()
    .tap();
  await page.waitForTimeout(1000);
  const res = await page.evaluate(() => {
    const row = [...document.querySelectorAll(".frow")].find((r) =>
      r.querySelector(".conceal"),
    );
    if (!row) return null;
    const keys = [...row.querySelectorAll(".icon-btn")].filter(
      (n) => n.getBoundingClientRect().width > 0,
    );
    const centres = keys.map((n) =>
      Math.round(
        n.getBoundingClientRect().top + n.getBoundingClientRect().height / 2,
      ),
    );
    return { count: keys.length, centres };
  });
  harness.check(
    res !== null && res.count >= 3,
    `${stop("password-keys")}: a saved account shows its password row with three keys (${res?.count ?? 0})`,
  );
  if (!res) return;
  harness.check(
    Math.max(...res.centres) - Math.min(...res.centres) <= 2,
    `${stop("password-keys")}: the password's keys sit on one line (${res.centres.join(", ")})`,
  );
}

/** One handle for the walk, which has no room for four imports. */
export const phonePolish = {
  topbarPromptFits,
  switchesAligned,
  searchKeysBare,
  passwordKeysOneLine,
};
