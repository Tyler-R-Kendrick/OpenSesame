/**
 * Where keys sit and how wide fields grow, measured in the page
 * (DESIGN.md § Keys have a home, § Fields have a measure).
 *
 * `scripts/quality/design-lint.mjs` holds the source to the same rules, but a lint
 * reads one file and these faults are the product of several: a key that is
 * alone on its row because its field wrapped, a field that is 900px wide
 * because two stylesheets agreed it could be. So `mobile-contract.mjs` runs
 * this at every stop of the touch journey, phones and tablets alike.
 *
 * A string, like the audit it joins, so it crosses into the page without a
 * bundler. It returns faults in the audit's own shape.
 */

/** The single-line measure (--field-max) and the editor measure (--text-max). */
export const FIELD_MAX = 480;
export const TEXT_MAX = 736;

export const LAYOUT_AUDIT =
  String.raw`() => {
  const faults = [];
  const where = (node) => {
    const parts = [];
    for (let n = node; n && n !== document.body; n = n.parentElement) {
      const cls = typeof n.className === "string" && n.className.trim()
        ? "." + n.className.trim().split(/\s+/).slice(0, 2).join(".")
        : "";
      parts.unshift(n.tagName.toLowerCase() + cls);
    }
    return parts.slice(-4).join(" > ");
  };
  const label = (el) => (el.getAttribute("aria-label") || el.getAttribute("title")
    || el.tagName).trim().slice(0, 44);
  // Drawn at all: a label hidden from assistive technology still sits on the
  // row — the verb beside a .go square is aria-hidden on purpose.
  // Each element's style is read once and its ancestors' answers are reused,
  // so a stop with a thousand rows stays linear.
  const shown = new Map();
  const visibleUp = (el) => {
    if (!el) return true;
    if (shown.has(el)) return shown.get(el);
    const s = getComputedStyle(el);
    const ok = s.display !== "none" && s.visibility !== "hidden"
      && !el.hasAttribute("hidden") && !el.classList.contains("visually-hidden")
      && visibleUp(el.parentElement);
    shown.set(el, ok);
    return ok;
  };
  const drawn = (el) => {
    const r = el.getBoundingClientRect();
    return r.width >= 2 && r.height >= 2 && visibleUp(el);
  };
  const iconOnly = (el) => !el.textContent.trim() && el.querySelector("svg");

  // 9. A key is never alone on a row. The chrome is exempt by name: its
  //    strips are rows of keys by design (statusline, top bar, drawer, the
  //    vault's path strip and tree keys, the rail).
  const CHROME = ".statusline, .topbar, .drawer, .railtree, .vtree__keys, "
    + ".vault-pathbar, .sheet__head, .keymap, nav";
  const keys = [...document.querySelectorAll("main button, main a")]
    .filter((el) => drawn(el) && iconOnly(el) && !el.closest(CHROME));
  // Only a stop with a key pays for the row-mates, and each is measured once.
  const mates = keys.length === 0 ? [] : [...document.querySelectorAll("main *")]
    .filter((el) => {
      if (!drawn(el)) return false;
      if (/^(INPUT|SELECT|TEXTAREA|IMG|OUTPUT|SUMMARY)$/.test(el.tagName)) return true;
      if (el.matches("button, a") && !iconOnly(el)) return true;
      return [...el.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim());
    })
    .map((el) => ({ el, rect: el.getBoundingClientRect() }));
  for (const key of keys) {
    const box = key.getBoundingClientRect();
    const scope = key.closest("li, form, section, .panel, .card, main") || document.body;
    const shared = mates.some(({ el, rect }) => {
      if (rect.bottom <= box.top + 4 || rect.top >= box.bottom - 4) return false;
      return !key.contains(el) && scope.contains(el);
    });
    if (!shared) {
      faults.push({ kind: "KEY-ALONE-ON-A-ROW", what: label(key), where: where(key) });
    }
  }

  // 10. A field has a measure. Only a screen wider than the measure can show
  //     the fault; a phone's fields fill their row by design.
  const vw = document.documentElement.clientWidth;
  if (vw > 900) {
    const SPAN = ".command-bar, .vtree__cmd, .codefield, .set-raw, .slash";
    for (const field of document.querySelectorAll("main input, main select, main textarea")) {
      if (!drawn(field) || field.closest(SPAN)) continue;
      const type = (field.getAttribute("type") || "").toLowerCase();
      if (["checkbox", "radio", "range", "file", "hidden", "color"].includes(type)) continue;
      const width = field.getBoundingClientRect().width;
      const measure = field.tagName === "TEXTAREA" ? ` +
  TEXT_MAX +
  String.raw` : ` +
  FIELD_MAX +
  String.raw`;
      // A field shell's input is measured by its shell.
      const outer = field.closest(".f__shell") || field;
      if (outer.getBoundingClientRect().width > measure + 1 && width > measure + 1) {
        faults.push({
          kind: "FIELD-WIDER-THAN-ITS-MEASURE",
          what: label(field) + " w=" + Math.round(width),
          where: where(field),
        });
      }
    }
  }
  return faults;
}`;

/**
 * The tablet's Settings stops. A field's measure only shows above 900px, and
 * the vault — the one screen the tablet walk visited — has no form, so the
 * check had nothing to measure. General holds a code editor and a one-field
 * form; Security holds the Transport form's selects, which grew to 800px.
 */
export async function auditSettings(page, audit, stop) {
  await page.locator(".railtree__row", { hasText: "settings" }).first().tap();
  await page.waitForTimeout(700);
  await audit(stop("settings-general"));
  await page.getByRole("link", { name: "Security", exact: true }).first().tap();
  await page.waitForTimeout(900);
  await audit(stop("settings-security"));
}
