import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

let captureSequence = 0;

export async function captureKeyboardFailure(page, target, key) {
  const out = process.env.KEYBOARD_DIAGNOSTIC_OUT;
  if (!out) throw new Error("Missing diagnostic output directory");
  await mkdir(out, { recursive: true });
  const describe = (node) => {
    if (!(node instanceof Element)) return null;
    const style = getComputedStyle(node);
    const rect = node.getBoundingClientRect();
    const ancestors = [];
    for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
      if (ancestor instanceof HTMLDetailsElement)
        ancestors.push({ tag: "DETAILS", open: ancestor.open });
      if (ancestor instanceof HTMLFieldSetElement)
        ancestors.push({ tag: "FIELDSET", disabled: ancestor.disabled });
    }
    return {
      tag: node.tagName,
      role: node.getAttribute("role"),
      disabled: "disabled" in node ? node.disabled : null,
      ariaDisabled: node.getAttribute("aria-disabled"),
      tabIndex: node instanceof HTMLElement ? node.tabIndex : null,
      rect: { x: rect.x, y: rect.y, width: rect.width, height: rect.height },
      visibility: style.visibility,
      display: style.display,
      opacity: style.opacity,
      inert: Boolean(node.closest("[inert]")),
      ancestors,
    };
  };
  const targetDescriptor = await target.evaluate(describe);
  const activeDescriptor = await page.locator(":focus").evaluate(describe).catch(() => null);
  const statuses = {};
  const known = new Set(["No active local session.", "Signed in locally with a passkey.", "Passkey enrolled.", "Passkey revoked."]);
  for (const name of ["Local session status", "Passkey status"]) {
    const status = page.getByRole("status", { name, exact: true });
    statuses[name] = (await status.allTextContents()).map((text) => known.has(text.trim()) ? text.trim() : "other");
  }
  const failureName = key === "readiness" ? "keyboard-readiness-failure" : "keyboard-tab-exhaustion";
  await writeFile(join(out, `${failureName}.json`), JSON.stringify({
    key, width: page.viewportSize()?.width, budget: key === "readiness" ? null : 160,
    target: targetDescriptor, active: activeDescriptor, statuses,
  }, null, 2));
  await flushKeyboardTrace(page);
  await page.screenshot({ path: join(out, `${failureName}.png`) });
}

export async function installKeyboardTrace(page) {
  await page.addInitScript(() => {
    const rows = [];
    let total = 0;
    let previous = "";
    let hadTargets = false;
    let nodeSequence = 0;
    const ordinals = new WeakMap();
    const ordinal = (node) => {
      if (!(node instanceof Element)) return null;
      if (!ordinals.has(node)) ordinals.set(node, ++nodeSequence);
      return ordinals.get(node);
    };
    const fixedStatuses = new Set([
      "No active local session.", "Signed in locally with a passkey.",
      "Passkey enrolled.", "Passkey revoked.",
    ]);
    const describe = (node) => {
      const rect = node.getBoundingClientRect();
      const style = getComputedStyle(node);
      const ancestors = [];
      for (let ancestor = node.parentElement; ancestor; ancestor = ancestor.parentElement) {
        if (ancestor instanceof HTMLDetailsElement) ancestors.push({ detailsOpen: ancestor.open });
        if (ancestor instanceof HTMLFieldSetElement) ancestors.push({ fieldsetDisabled: ancestor.disabled });
      }
      return {
        ordinal: ordinal(node), connected: node.isConnected, disabled: node.disabled,
        ariaDisabled: node.getAttribute("aria-disabled"), tabIndex: node.tabIndex,
        visible: rect.width > 0 && rect.height > 0 && style.visibility !== "hidden" && style.display !== "none",
        inert: Boolean(node.closest("[inert]")), ancestors,
      };
    };
    const record = (event) => {
      const buttons = [...document.querySelectorAll("button")];
      const matches = (node, label) => node.getAttribute("aria-label") === label || node.textContent.trim() === label;
      const disable = buttons.filter((node) => matches(node, "Disable"));
      const enable = buttons.filter((node) => matches(node, "Enable"));
      // Only this fixture's directory lifecycle is relevant to this trace.
      if (!disable.length && !enable.length) {
        if (!hadTargets) return;
        hadTargets = false;
      } else hadTargets = true;
      const active = document.activeElement;
      const statuses = {};
      for (const name of ["Local session status", "Passkey status"]) {
        statuses[name] = [...document.querySelectorAll(`[role="status"][aria-label="${name}"]`)]
          .map((node) => fixedStatuses.has(node.textContent.trim()) ? node.textContent.trim() : "other");
      }
      const state = {
        disableCount: disable.length, enableCount: enable.length,
        visibleDisableCount: disable.filter((node) => describe(node).visible).length,
        visibleEnableCount: enable.filter((node) => describe(node).visible).length,
        disable: disable.map(describe), enable: enable.map(describe),
        active: { ordinal: ordinal(active), tag: active?.tagName ?? null, tabIndex: active instanceof HTMLElement ? active.tabIndex : null, isDisable: disable.includes(active), isEnable: enable.includes(active) },
        statuses,
      };
      const signature = JSON.stringify(state);
      if (event === "mutation" && signature === previous) return;
      previous = signature;
      total++;
      rows.push({ at: performance.now(), event, ...state });
      if (rows.length > 512) rows.splice(128, 1);
    };
    Object.defineProperty(window, "__keyboardDiagnosticTrace", { value: { rows, get total() { return total; } } });
    new MutationObserver(() => record("mutation")).observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ["disabled", "aria-disabled", "tabindex", "open", "inert", "class", "style"] });
    document.addEventListener("focusin", () => record("focusin"));
    document.addEventListener("keydown", (event) => { if (event.key === "Tab") record(event.shiftKey ? "Shift+Tab" : "Tab"); }, true);
  });
}

export async function flushKeyboardTrace(page) {
  const trace = await page.evaluate(() => {
    const trace = window.__keyboardDiagnosticTrace;
    return trace ? { rows: trace.rows, total: trace.total, limit: 512 } : null;
  });
  if (!trace || trace.rows.length === 0) return;
  const out = process.env.KEYBOARD_DIAGNOSTIC_OUT;
  await mkdir(out, { recursive: true });
  await writeFile(join(out, `keyboard-state-trace-${page.viewportSize().width}-${++captureSequence}.json`), JSON.stringify(trace, null, 2));
}
