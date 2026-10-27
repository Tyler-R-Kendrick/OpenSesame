import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

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
      label: node.getAttribute("aria-label"),
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
  for (const name of ["Local session status", "Passkey status"]) {
    const status = page.getByRole("status", { name, exact: true });
    statuses[name] = await status.allTextContents();
  }
  await writeFile(join(out, "keyboard-tab-exhaustion.json"), JSON.stringify({
    key, width: page.viewportSize()?.width, budget: 160,
    target: targetDescriptor, active: activeDescriptor, statuses,
  }, null, 2));
  await page.screenshot({ path: join(out, "keyboard-tab-exhaustion.png") });
}
