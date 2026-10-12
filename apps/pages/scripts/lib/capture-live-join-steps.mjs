/**
 * Capture verbs for a live session that is actually joined (ADR 0150 §5): an
 * owner whose vault is heavy, and a joiner in a browser of its own who goes
 * the whole way — the link, the code, the request, the reply — over a real
 * WebRTC connection, and then says what it was shown.
 *
 * `liveView` points the journey's `shot` at the joiner's page instead of the
 * owner's, so a sheet can show either end of the same session.
 */

import { ask, grantClipboard, owners } from "./capture-live-steps.mjs";
import { phoneContext } from "./mobile-contract.mjs";

/** Which page a `shot` takes, per owner page: absent means the owner's own. */
export const views = new WeakMap();

/** The page a `shot` step photographs. */
export const viewOf = (page) => views.get(page) ?? page;

/** The joiner's browser: the owner's device class, a context of its own. */
async function joinerFor(page, harness) {
  const phone = await page.evaluate(() => "ontouchstart" in window);
  const { width, height } = page.viewportSize();
  return harness.newPage(page.context().browser(), {
    device: phone
      ? phoneContext({ width, height })
      : { viewport: { width, height } },
  });
}

/** A line of what a page's status marks say, for the log. */
const marksOf = (scope) =>
  scope
    .locator("[role=img][aria-label]")
    .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label")));

/**
 * Reach the new-item form. The key is there on a desktop; a phone shows the
 * item just saved over the list, so it follows the vault's own route.
 */
async function openNewItem(page) {
  const key = page.getByRole("link", { name: "New item", exact: true });
  if (await key.count()) await key.first().click();
  else
    await page.evaluate(() => {
      const base = location.pathname.replace(/vault\/?.*$/, "");
      window.history.pushState(null, "", `${base}vault/new`);
      dispatchEvent(new PopStateEvent("popstate"));
    });
  await page.getByLabel("Name", { exact: true }).waitFor();
}

/** One item with `fields` plain custom fields of `bytes` characters. */
async function keepItem(page, name, { fields, bytes }) {
  await openNewItem(page);
  await page.getByLabel("Name", { exact: true }).fill(name);
  for (let field = 0; field < fields; field += 1) {
    const add =
      field === 0
        ? page.getByRole("button", { name: "custom field" })
        : page.getByRole("button", { name: "Add field" });
    await add.first().click();
    await page
      .getByLabel("Field name", { exact: true })
      .last()
      .fill(`Field ${field + 1}`);
    await page
      .getByLabel("Field value", { exact: true })
      .last()
      .fill("x".repeat(bytes));
  }
  await page
    .getByRole("button", { name: "Save item", exact: true })
    .first()
    .click();
  await page.waitForTimeout(900);
}

/**
 * The joiner's walk: open the link, give the code, be let in by hand, take
 * the reply, connect. Resolves to the joiner's page.
 */
async function joinThrough(page, harness, { link, code }, name) {
  const own = page.locator("#live-session");
  const { page: seat } = await joinerFor(page, harness);
  const request = await ask(seat, { link, code, name });
  await own.getByLabel("A request code", { exact: true }).fill(request);
  await own.getByRole("button", { name: "Read the request" }).click();
  await own.getByRole("button", { name: `Let ${name} in` }).click();
  const reply = own.getByRole("button", {
    name: `Copy the reply code for ${name}`,
  });
  await reply.waitFor({ timeout: 20_000 });
  await grantClipboard(page);
  await reply.click();
  const answer = await page.evaluate(() => navigator.clipboard.readText());
  await seat.getByLabel("The owner's reply code", { exact: true }).fill(answer);
  await seat.getByRole("button", { name: "Connect" }).click();
  return seat;
}

/** How many items a joiner's catalog lists and its longest plain text. */
const catalogOf = (seat) =>
  seat.evaluate(() => {
    const rows = [...document.querySelectorAll(".live-items > li")];
    const longest = rows
      .flatMap((row) => [...row.querySelectorAll("*")])
      .filter((node) => node.children.length === 0)
      .reduce((most, node) => Math.max(most, node.textContent.length), 0);
    return { items: rows.length, longest };
  });

export function liveJoinSteps({ harness }) {
  return {
    /**
     * Keep `items` items in the open vault, each with `fields` custom fields
     * of `bytes` characters of plain text: a vault at the limits (200 items x
     * 32 fields x 16 KiB), as a person fills it in, one field at a time.
     */
    async liveWeigh(page, { items, fields, bytes }) {
      for (let at = 0; at < items; at += 1)
        await keepItem(page, `Item ${at + 1}`, { fields, bytes });
      console.log(`  liveWeigh: ${items} items x ${fields} fields x ${bytes}`);
    },

    /**
     * The owner has started an invite session and copied its link. A joiner
     * opens it, gives the code, is let in by hand, connects, and says what
     * it was shown: its marks.
     */
    async liveJoin(page, { name, wait = 30_000 }) {
      const held = owners.get(page);
      if (!held?.link) return console.log("  liveJoin: skipped (no session)");
      const seat = await joinThrough(page, harness, held, name);
      const joined = await seat
        .getByRole("img", { name: "Joined Team" })
        .waitFor({ timeout: wait })
        .then(() => true)
        .catch(() => false);
      await seat.waitForTimeout(1500);
      views.set(page, seat);
      console.log(`  liveJoin: joiner reached "Joined Team"=${joined}`);
      console.log(`  joiner marks: ${(await marksOf(seat)).join(" | ")}`);
      const own = page.locator("#live-session");
      console.log(`  owner marks: ${(await marksOf(own)).join(" | ")}`);
    },

    /** What the joiner was shown, read from its page. */
    async liveCatalog(page) {
      const seat = views.get(page);
      if (!seat) return console.log("  liveCatalog: skipped (no joiner)");
      const shown = await catalogOf(seat);
      console.log(
        `  liveCatalog: joiner lists ${shown.items} items, longest plain text ${shown.longest} characters`,
      );
    },

    /**
     * The owner's browser loses the catalog frames it sends — the first
     * `catalogs` of them, or `"all"` — as Chromium can drop the first frame a
     * side sends the moment its data channel appears (ADR 0186). Induced, so
     * a capture shows that condition every time; nothing else is touched.
     */
    async liveLose(page, { catalogs }) {
      await page.evaluate(
        (count) => {
          const send = RTCDataChannel.prototype.send;
          let left = count ?? Number.POSITIVE_INFINITY;
          RTCDataChannel.prototype.send = function (data) {
            if (left > 0 && String(data).startsWith('{"t":"catalog"')) {
              left -= 1;
              return;
            }
            return send.call(this, data);
          };
        },
        catalogs === "all" ? null : catalogs,
      );
      console.log(`  liveLose: the owner's browser drops ${catalogs} catalog`);
    },

    /** Point `shot` back at the owner (the joiner is the default after a join). */
    async liveView(page, who) {
      if (who === "owner") views.delete(page);
      console.log(`  liveView: shots show the ${who}`);
    },
  };
}
