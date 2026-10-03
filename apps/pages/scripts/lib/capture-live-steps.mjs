/**
 * Capture verbs for live sessions (ADR 0150): an owner who starts one, and
 * the browsers that come to it. A session has two ends, so a verb here may
 * open a second browser context of its own — a joiner on the same origin —
 * and say plainly what each end showed.
 *
 * Every verb is a no-op where the build has no Live sessions panel (the base
 * of a pull request that adds it): it prints that it skipped, so a journey's
 * before/after pair reads "absent → present" from the browser, not from the
 * diff. `press` is `capture-evidence.mjs`'s tap-or-click; `harness` opens a
 * page that serves the build under test.
 */

/** Letters of the invite alphabet that are not any real code. */
const WRONG_CODES = [
  "BCDFGHJK",
  "BCDFGHJL",
  "BCDFGHJM",
  "BCDFGHJN",
  "BCDFGHJP",
  "BCDFGHJQ",
];

/** What each page's owner panel held, so later verbs need not look again. */
export const owners = new WeakMap();

/** Where the keyboard is, in words a journey can print. */
function describeFocus() {
  // A short selector for the element a point lands on. Declared inside: this
  // function is serialised into the page, so nothing outside it exists there.
  const selectorOf = (node) => {
    if (!node) return "none";
    const id = node.id ? `#${node.id}` : "";
    const classes =
      typeof node.className === "string" && node.className.trim()
        ? `.${node.className.trim().split(/\s+/).join(".")}`
        : "";
    return `${node.tagName.toLowerCase()}${id}${classes}`;
  };
  const el = document.activeElement;
  if (!el || el === document.body) return "BODY (nothing focused)";
  const box = el.getBoundingClientRect();
  const style = getComputedStyle(el);
  const name =
    el.getAttribute("aria-label") || el.id || el.textContent?.trim() || "";
  // Drawn where a person can see it: inside the viewport, and the topmost
  // thing at its centre — not behind a sticky bar.
  const at = document.elementFromPoint(
    box.left + box.width / 2,
    box.top + box.height / 2,
  );
  const shown =
    box.top >= 0 &&
    box.bottom <= innerHeight &&
    at !== null &&
    (at === el || el.contains(at));
  return [
    `${el.tagName} "${name}"`,
    `focus-visible=${el.matches(":focus-visible")}`,
    `on screen and unobscured=${shown}`,
    `elementFromPoint at its centre: ${selectorOf(at)}`,
    `box ${Math.round(box.width)}x${Math.round(box.height)} @${Math.round(box.left)},${Math.round(box.top)}`,
    `outline ${style.outlineStyle} ${style.outlineWidth} ${style.outlineColor}`,
  ].join(" | ");
}

/** Tab until `locator` holds the keyboard; never injects focus. */
async function tabTo(page, locator, limit = 160) {
  for (let step = 0; step < limit; step += 1) {
    const there = await locator
      .evaluate((node) => node === document.activeElement)
      .catch(() => false);
    if (there) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("capture-evidence: Tab never reached the control");
}

export async function grantClipboard(page, address = page.url()) {
  const { origin } = new URL(address);
  await page
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], { origin });
}

/** A second browser, on the same deployment, that joins what the owner hosts. */
async function joiner(page, harness) {
  const browser = page.context().browser();
  const made = await harness.newPage(browser, {
    device: { viewport: { width: 1280, height: 900 } },
  });
  return made;
}

/** The joiner opens the link, enters `code` and a name, and asks. */
export async function ask(page, { link, code, name }) {
  await grantClipboard(page, link);
  await page.goto(link, { waitUntil: "networkidle" });
  await page.waitForTimeout(5200);
  await page
    .getByRole("heading", { level: 1, name: "Join a session" })
    .waitFor({ timeout: 20_000 });
  const apply = page.getByRole("button", { name: "Apply configuration" });
  if (await apply.isVisible().catch(() => false)) await apply.click();
  await page.getByLabel("Your name").waitFor({ timeout: 20_000 });
  await page.getByLabel("Code").fill(code.toLowerCase());
  await page.getByLabel("Your name").fill(name);
  await page.getByRole("button", { name: "Ask to join" }).click();
  const copy = page.getByRole("button", { name: "Copy your request code" });
  await copy.waitFor({ timeout: 30_000 });
  await copy.click();
  return page.evaluate(() => navigator.clipboard.readText());
}

/** The panel, or null on a build that has none. */
const panelOf = (page) =>
  owners.get(page) ? page.locator("#live-session") : null;

/** Verbs that only read the page. */
function readingSteps() {
  return {
    /**
     * Say whether this build has the Live sessions panel here. Every later
     * live verb follows that answer.
     */
    async liveHas(page) {
      const has = (await page.locator("#live-session").count()) > 0;
      owners.set(page, has ? { link: null, code: null } : null);
      console.log(`  live panel: ${has ? "present" : "absent in this build"}`);
    },

    /**
     * A joiner who has the link types the out-of-band code and a name, then
     * the page says whether the Ask to join key is enabled. A screen that
     * refused the link has no form: that is the answer, printed as such.
     */
    async liveAsk(page, { code, name }) {
      const form = page.locator(".live-join form");
      const field = form.getByLabel("Code");
      if (!(await field.count()))
        return console.log("  liveAsk: no form (the link was refused)");
      await field.fill(code.toLowerCase());
      await form.getByLabel("Your name").fill(name);
      const ask = form.getByRole("button", { name: "Ask to join" });
      console.log(`  liveAsk: Ask to join enabled=${await ask.isEnabled()}`);
    },

    /** Print where the keyboard is:`document.activeElement`, read in the page. */
    async focused(page) {
      console.log(`  focused: ${await page.evaluate(describeFocus)}`);
    },

    /** Print the status marks (their accessible names) inside `selector`. */
    async marks(page, selector) {
      const names = await page
        .locator(`${selector} [role=img][aria-label]`)
        .evaluateAll((nodes) => nodes.map((n) => n.getAttribute("aria-label")));
      console.log(
        `  marks ${selector} (${names.length}): ${names.join(" | ") || "none"}`,
      );
    },
  };
}

/** The owner's verbs: Routes, Start, and handing out the link. */
function ownerSteps() {
  return {
    /**
     * Add the carriers `[{ kind, url }]` to Routes, through the Form, the way
     * an owner would.
     */
    async liveRoutes(page, carriers) {
      const own = panelOf(page);
      if (!own) return console.log("  liveRoutes: skipped (no panel)");
      const routes = page.locator("#live-routes");
      for (const carrier of carriers) {
        await routes.getByLabel("Code carrier").selectOption(carrier.kind);
        await routes.getByLabel(/^Server \(/).fill(carrier.url);
        await routes.getByRole("button", { name: "Add the carrier" }).click();
        await page.waitForTimeout(500);
      }
      console.log(
        `  routes now name ${await routes.getByText(carriers[0].url, { exact: true }).count()} x ${carriers[0].url}`,
      );
    },

    /**
     * Name a session after the one login on the device and start it.
     * `keyboard` takes every step with Tab, Space and Enter, so the keyboard
     * ends wherever the page leaves it.
     */
    async liveStart(page, options) {
      const {
        admission = "invite",
        keyboard = false,
        wholeVault = false,
      } = options ?? {};
      const own = panelOf(page);
      if (!own) return console.log("  liveStart: skipped (no panel)");
      const name = own.getByLabel("Session name");
      const item = own.getByRole("checkbox", { name: "GitHub" });
      const start = own.getByRole("button", { name: "Start the live session" });
      if (admission === "open")
        await own.getByLabel("Who gets in").selectOption("open");
      if (keyboard) {
        await tabTo(page, name);
        await page.keyboard.insertText("Team");
        await tabTo(page, item);
        await page.keyboard.press("Space");
        await tabTo(page, start);
        await page.keyboard.press("Enter");
      } else {
        await name.fill("Team");
        if (wholeVault) await own.getByLabel("Share").selectOption("vault");
        else await item.check();
        await start.click();
      }
      await own.getByRole("img", { name: "Live" }).waitFor();
      await page.waitForTimeout(600);
      console.log("  liveStart: session is Live");
    },

    /** Copy the link and the code the owner hands out, without a screenshot. */
    async liveLink(page) {
      const own = panelOf(page);
      if (!own) return console.log("  liveLink: skipped (no panel)");
      await grantClipboard(page);
      const held = owners.get(page);
      held.code = (await own.locator(".live-code").innerText()).trim();
      await own.getByRole("button", { name: "Copy the link" }).click();
      held.link = await page.evaluate(() => navigator.clipboard.readText());
      console.log("  liveLink: copied the link and the code");
    },
  };
}

/** The verbs that bring other browsers to the owner's session. */
function guestSteps(harness) {
  return {
    /**
     * Five people who hold the link and guess the code. Each is a browser of
     * its own: it opens the link, gives a wrong code, and the owner pastes
     * its request code. `attempts` is how many are made.
     */
    async liveGuess(page, count) {
      const attempts = count ?? 5;
      const own = panelOf(page);
      if (!own) return console.log("  liveGuess: skipped (no panel)");
      const { link } = owners.get(page);
      const field = own.getByLabel("A request code", { exact: true });
      for (let miss = 0; miss < attempts; miss += 1) {
        const made = await joiner(page, harness);
        try {
          const request = await ask(made.page, {
            link,
            code: WRONG_CODES[miss],
            name: `Guesser ${miss + 1}`,
          });
          await field.fill(request);
          await own.getByRole("button", { name: "Read the request" }).click();
          await page.waitForTimeout(900);
          const said = await own
            .locator(
              "[role=img][aria-label^='Not for this session'], [role=img][aria-label$='locked']",
            )
            .evaluateAll((nodes) =>
              nodes.map((n) => n.getAttribute("aria-label")),
            );
          console.log(`  guess ${miss + 1}: owner says ${said.join(" | ")}`);
        } finally {
          await made.context.close();
        }
      }
    },

    /** Bring the owner's session panel to the top of the viewport. */
    async liveScroll(page) {
      if (!panelOf(page)) return;
      await page.locator("#live-session").evaluate((node) => {
        node.scrollIntoView({ block: "start", behavior: "instant" });
      });
      await page.waitForTimeout(500);
    },
  };
}

export function liveSteps({ harness }) {
  return { ...readingSteps(), ...ownerSteps(), ...guestSteps(harness) };
}
