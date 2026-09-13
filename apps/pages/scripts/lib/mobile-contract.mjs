/**
 * What a phone is owed, measured in a real touch context.
 *
 * DESIGN.md's Touch section states the rules; this is the only place that
 * checks them, so a screen cannot quietly opt out of one. Everything here runs
 * against computed geometry in the page — not against class names, not against
 * a snapshot — because every one of these faults (a 20px key, a strip that
 * scrolled its own tab off the screen, a 14px field that makes iOS zoom and
 * never zoom back) is invisible to a DOM assertion and obvious to a finger.
 *
 * The audit is one `page.evaluate` so a stop costs one round trip; the
 * journey that drives it lives in `verify-mobile.mjs`.
 */

/** The product floor. A finger is ~9mm; 44 CSS px is the smallest honest key. */
export const TOUCH_FLOOR = 44;

/**
 * iOS Safari zooms the page when a focused form control is set below 16px and
 * does not zoom back out. Every other mobile defect is cosmetic next to that
 * one: it strands the user in a viewport they cannot restore.
 */
export const NO_ZOOM_FLOOR = 16;

/**
 * Phones this gate speaks for. 320 is the floor width still in the wild, and
 * landscape is not an afterthought: rotated, a phone has 390px of height for a
 * top bar, a statusline, a tab bar and the content between them, which is
 * where a frame built in portrait falls apart.
 */
export const PHONES = [
  { name: "320", width: 320, height: 568 },
  { name: "390", width: 390, height: 844 },
  { name: "430", width: 430, height: 932 },
  { name: "landscape", width: 844, height: 390 },
];

/** Emulation that makes `(pointer: coarse)` true. Without it we measure the
 *  mouse stylesheet and every touch rule reads as passing. */
export function phoneContext({ width, height }) {
  return {
    viewport: { width, height },
    hasTouch: true,
    isMobile: true,
    deviceScaleFactor: 3,
  };
}

/**
 * The audit, as a string so it can cross into the page without a bundler.
 *
 * Exemptions are named rather than blanket-skipped: an inline link inside
 * prose is exempt because WCAG 2.5.8 exempts it, a disabled control because it
 * cannot be hit, and a visually-hidden control only on the condition that it
 * really is hidden — a 3px-wide input is still a hit target, and that is the
 * bug this clause catches rather than excuses.
 */
export const AUDIT =
  String.raw`() => {
  const vw = document.documentElement.clientWidth;
  const vh = document.documentElement.clientHeight;
  const faults = [];
  const fail = (kind, what, node) => faults.push({ kind, what, where: where(node) });

  function where(node) {
    if (!node) return "";
    const parts = [];
    for (let n = node; n && n !== document.body; n = n.parentElement) {
      const cls = typeof n.className === "string" && n.className.trim()
        ? "." + n.className.trim().split(/\s+/).slice(0, 2).join(".")
        : "";
      parts.unshift(n.tagName.toLowerCase() + cls);
    }
    return parts.slice(-4).join(" > ");
  }

  function name(el) {
    const text = (el.getAttribute("aria-label")
      || el.getAttribute("title")
      || el.textContent
      || el.getAttribute("placeholder")
      || el.tagName).trim().replace(/\s+/g, " ");
    return text.slice(0, 44) || el.tagName;
  }

  function hidden(el) {
    const style = getComputedStyle(el);
    if (style.visibility === "hidden" || style.display === "none") return true;
    return Boolean(el.closest("[hidden]") || el.closest('[aria-hidden="true"]'));
  }

  /**
   * What of an element is actually on screen: its own box, clipped by every
   * ancestor that clips. A row scrolled out of a pane still reports a full
   * rect, so without this an overlay "covers" things nobody can see.
   */
  function visibleRect(el) {
    let box = el.getBoundingClientRect();
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const style = getComputedStyle(n);
      if (style.overflowX === "visible" && style.overflowY === "visible") continue;
      const clip = n.getBoundingClientRect();
      const top = Math.max(box.top, clip.top);
      const left = Math.max(box.left, clip.left);
      const right = Math.min(box.right, clip.right);
      const bottom = Math.min(box.bottom, clip.bottom);
      box = { top, left, right, bottom, width: right - left, height: bottom - top };
      if (box.width <= 0 || box.height <= 0) return box;
    }
    return box;
  }

  /** The nearest ancestor that can actually scroll this element sideways. */
  function scroller(el) {
    for (let n = el.parentElement; n && n !== document.body; n = n.parentElement) {
      const overflow = getComputedStyle(n).overflowX;
      if ((overflow === "auto" || overflow === "scroll") && n.scrollWidth > n.clientWidth + 1) {
        return n;
      }
    }
    return null;
  }

  // 1. The page itself never scrolls sideways. Shrink-to-fit scales every
  //    target away from where it was drawn, so this outranks the rest.
  const doc = document.scrollingElement || document.documentElement;
  if (doc.scrollWidth > vw + 1) {
    fail("PAGE-WIDER-THAN-PHONE", "document scrollWidth " + doc.scrollWidth + " > " + vw, doc);
  }

  // 2. Nothing in normal flow is wider than the phone unless it declares
  //    itself a scroller. A bled-out strip that overshoots its own gutter is
  //    the usual cause and never looks like a bug in a desktop screenshot.
  for (const el of document.querySelectorAll("body *")) {
    if (hidden(el)) continue;
    const style = getComputedStyle(el);
    if (style.position === "fixed" || style.position === "absolute") continue;
    if (style.overflowX === "auto" || style.overflowX === "scroll") continue;
    const rect = el.getBoundingClientRect();
    if (rect.width > vw + 1) {
      fail("ELEMENT-WIDER-THAN-PHONE", name(el) + " w=" + Math.round(rect.width), el);
    }
  }

  const CONTROLS = "a,button,input,select,textarea,summary,[role=button],[role=tab],"
    + "[role=treeitem],[role=switch],[role=checkbox],[role=menuitem],[role=option]";
  const seen = new Set();

  for (const el of document.querySelectorAll(CONTROLS)) {
    if (hidden(el)) continue;
    const rect = el.getBoundingClientRect();
    const label = name(el);
    const size = Math.round(rect.width) + "x" + Math.round(rect.height);

    // A control marked visually hidden must really be a point, not a sliver
    // that a thumb can land on and a sighted user can never see.
    const veiled = el.classList.contains("visually-hidden") || el.closest(".visually-hidden");
    if (veiled) {
      if (rect.width > 2 || rect.height > 2) {
        fail("HIDDEN-CONTROL-IS-A-TARGET", label + " " + size, el);
      }
      continue;
    }

    if (rect.width === 0 && rect.height === 0) continue;
    if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
    // WCAG 2.5.8 exempts a target inline in a sentence: the sentence sets its
    // size, and growing it would break the line it lives in.
    if (el.tagName === "A" && el.closest("p,li,.hint,.set__note,.notice-card p")) continue;
    // A label is the target only when it wraps its own control; otherwise the
    // control it points at is measured on its own turn.
    if (el.tagName === "LABEL" && !el.querySelector("input,select,textarea")) continue;

    const key = label + "|" + size + "|" + where(el);
    if (seen.has(key)) continue;
    seen.add(key);

    if (rect.width + 0.5 < ` +
  TOUCH_FLOOR +
  String.raw` || rect.height + 0.5 < ` +
  TOUCH_FLOOR +
  String.raw`) {
      fail("TARGET-UNDER-44", label + " " + size, el);
    }

    // 3. A control the thumb cannot reach sideways. Vertical is not the same
    //    question — a long page is meant to scroll down — but a control past
    //    the left or right edge of a phone is reachable only if something
    //    around it actually scrolls that way.
    const off = rect.right < 1 || rect.left > vw - 1;
    if (off && !scroller(el)) {
      fail("STRANDED", label + " at x=" + Math.round(rect.left), el);
    }

    // 4. The selected thing in a strip must be visible without scrolling: a
    //    tab row that hides its own current tab tells the user nothing.
    const current = el.getAttribute("aria-selected") === "true"
      || el.getAttribute("aria-current") === "page"
      || el.classList.contains("is-active");
    if (current && (rect.left < -1 || rect.right > vw + 1)) {
      fail("SELECTED-OUT-OF-VIEW", label + " " + Math.round(rect.left) + ".." + Math.round(rect.right), el);
    }

    // 5. iOS zoom. Measured on the computed style, because the rule that sets
    //    it is usually three stylesheets away from the element.
    const form = el.tagName === "INPUT" || el.tagName === "SELECT" || el.tagName === "TEXTAREA";
    const type = (el.getAttribute("type") || "").toLowerCase();
    if (form && type !== "checkbox" && type !== "radio" && type !== "range" && type !== "color") {
      const px = Number.parseFloat(getComputedStyle(el).fontSize);
      if (px < ` +
  NO_ZOOM_FLOOR +
  String.raw` - 0.01) {
        fail("IOS-ZOOMS-ON-FOCUS", label + " font-size=" + px + "px", el);
      }
    }
  }

  // 6. The bottom chrome. It is a row of the frame, so it must sit on the
  //    bottom edge, stay one row tall, and keep clear of the home indicator.
  const strip = document.querySelector(".statusline");
  const tabs = document.querySelector(".tabbar");
  const chrome = {};
  if (strip) {
    const rect = strip.getBoundingClientRect();
    chrome.statusline = { h: Math.round(rect.height), w: Math.round(rect.width) };
    // One row of 44px keys plus the strip's own padding. Anything taller means
    // it wrapped, and a wrapped strip costs a phone a sixth of its screen.
    if (rect.height > 56) {
      fail("FOOTER-WRAPPED", "statusline is " + Math.round(rect.height) + "px tall", strip);
    }
    if (strip.scrollWidth > strip.clientWidth + 1) {
      fail("FOOTER-OVERFLOWS", "statusline scrollWidth " + strip.scrollWidth, strip);
    }
  }
  if (tabs) {
    const rect = tabs.getBoundingClientRect();
    chrome.tabbar = { h: Math.round(rect.height), bottom: Math.round(rect.bottom) };
    // The frame is rows, not overlays: the last row ends on the last pixel, so
    // nothing scrolls under it and nothing is hidden beneath it.
    if (Math.abs(rect.bottom - vh) > 1) {
      fail("TABBAR-OFF-THE-EDGE", "bottom " + Math.round(rect.bottom) + " vs " + vh, tabs);
    }
  }

  // 7. Nothing floating covers a control. A screen with no statusline seats
  //    the support mark as a fixed corner overlay, and on a phone the card
  //    beneath it runs nearly edge to edge — so the mark landed on top of
  //    "Continue as guest", a road that must never be hard to take. Geometry
  //    alone never shows this: both elements measure perfectly.
  for (const float of document.querySelectorAll("body *")) {
    if (getComputedStyle(float).position !== "fixed") continue;
    if (hidden(float)) continue;
    const over = float.getBoundingClientRect();
    if (over.width === 0 || over.height === 0) continue;
    // A scrim, a sheet and a modal are meant to cover the page.
    if (float.closest(".sheet-layer, .sheet, .scrim, dialog")) continue;
    if (over.width > vw * 0.8 && over.height > vh * 0.8) continue;
    for (const el of document.querySelectorAll(CONTROLS)) {
      if (el === float || float.contains(el) || el.contains(float)) continue;
      if (hidden(el) || el.disabled) continue;
      const rect = visibleRect(el);
      if (rect.width <= 0 || rect.height <= 0) continue;
      if (el.classList.contains("visually-hidden")) continue;
      const clash = !(rect.right <= over.left || rect.left >= over.right
        || rect.bottom <= over.top || rect.top >= over.bottom);
      if (clash) {
        fail("OVERLAY-COVERS-A-CONTROL", name(float) + " over " + name(el), el);
      }
    }
  }

  // 8. The chrome earns its height. Three bars that each look reasonable can
  //    still add up to most of a rotated phone, and the vault is the reason
  //    the app is open — so the frame keeps under a third of the screen.
  //    Measured as the rows the chrome actually covers, not the sum of the
  //    bars: two bars sharing one row cost that row once.
  const spans = [document.querySelector(".topbar"), strip, tabs]
    .filter(Boolean)
    .map((el) => el.getBoundingClientRect())
    .filter((r) => r.height > 0)
    .sort((a, b) => a.top - b.top);
  let bars = 0;
  let reach = Number.NEGATIVE_INFINITY;
  for (const rect of spans) {
    const from = Math.max(rect.top, reach);
    if (rect.bottom > from) bars += rect.bottom - from;
    reach = Math.max(reach, rect.bottom);
  }
  chrome.total = Math.round(bars);
  // Three bars at the 44px floor are ~140px whatever the screen, so a very
  //    short one is held to that budget rather than to a ratio it cannot meet.
  const budget = Math.max(vh * 0.34, 150);
  if (tabs && bars > budget) {
    fail(
      "CHROME-EATS-THE-SCREEN",
      Math.round(bars) + "px of chrome on a " + vh + "px screen (budget "
        + Math.round(budget) + ")",
      tabs,
    );
  }

  // Reported so the journey can refuse to trust a run that lost its
  // emulation: a check that measures the mouse stylesheet passes for free.
  return { faults, chrome, vw, vh, coarse: matchMedia("(pointer: coarse)").matches };
}`;

/**
 * Turn one stop's audit into gate failures.
 *
 * Every fault is a failure — there is no severity ladder, because a ladder is
 * how a floor becomes a suggestion. A screen that needs an exception states it
 * in the audit's own exemption clauses, where the next reader can see it.
 */
export function recordStop(harness, label, result) {
  // Name the stop before recording, or every failure is filed under the one
  // before it and the log points at the wrong screen.
  harness.setStep(label);
  for (const fault of result.faults) {
    harness.check(
      false,
      `${label}: ${fault.kind} — ${fault.what} [${fault.where}]`,
    );
  }
  if (result.faults.length === 0) {
    harness.check(true, `${label}: phone contract holds`);
  }
  return result.faults.length;
}
