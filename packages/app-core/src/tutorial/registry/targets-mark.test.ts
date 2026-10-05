/** @vitest-environment jsdom */

import { describe, expect, it } from "vitest";
import {
  GUIDE_TARGETS_ATTRIBUTE,
  mountGuideTarget,
  resolveGuideTargetElement,
} from "./targets.js";

function attached(): HTMLButtonElement {
  const element = document.createElement("button");
  document.body.append(element);
  return element;
}

describe("the attribute a bound control carries", () => {
  it("names the target while it is bound and drops it on unbind", () => {
    const element = attached();
    const detach = mountGuideTarget("vault.create", element);
    expect(element.getAttribute(GUIDE_TARGETS_ATTRIBUTE)).toBe("vault.create");
    expect(
      document.querySelector(`[${GUIDE_TARGETS_ATTRIBUTE}~="vault.create"]`),
    ).toBe(resolveGuideTargetElement("vault.create"));
    detach();
    expect(element.hasAttribute(GUIDE_TARGETS_ATTRIBUTE)).toBe(false);
    element.remove();
  });

  it("lists every id one element answers to and removes only the one unbound", () => {
    const element = attached();
    const first = mountGuideTarget("vault.create", element);
    const second = mountGuideTarget("shell.lock", element);
    expect(element.getAttribute(GUIDE_TARGETS_ATTRIBUTE)).toBe(
      "vault.create shell.lock",
    );
    first();
    expect(element.getAttribute(GUIDE_TARGETS_ATTRIBUTE)).toBe("shell.lock");
    second();
    expect(element.hasAttribute(GUIDE_TARGETS_ATTRIBUTE)).toBe(false);
    element.remove();
  });
});
