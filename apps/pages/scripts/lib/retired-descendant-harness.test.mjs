import { afterEach, describe, expect, it, vi } from "vitest";
import { actionableInternalAnchor } from "./retired-descendant-harness.mjs";

afterEach(() => vi.unstubAllGlobals());

function anchor({
  skip = false,
  href = "https://app.test/vault/",
  target = "",
  rect,
  covered = false,
  emptyHit = false,
} = {}) {
  const element = {
    href,
    target,
    matches: () => skip,
    getBoundingClientRect: () =>
      rect ?? { left: 10, top: 10, right: 90, bottom: 40 },
    contains: (hit) => hit === element,
  };
  vi.stubGlobal("location", { origin: "https://app.test" });
  vi.stubGlobal("innerWidth", 1280);
  vi.stubGlobal("innerHeight", 800);
  const hitTest = vi.fn(() => (emptyHit ? null : covered ? {} : element));
  vi.stubGlobal("document", { elementFromPoint: hitTest });
  return { element, hitTest };
}

describe("the genuine descendant pointer target", () => {
  it("excludes the clipped skip link that caused the hosted desktop timeout", () => {
    const { element, hitTest } = anchor({ skip: true });
    expect(actionableInternalAnchor(element)).toBe(false);
    expect(hitTest).not.toHaveBeenCalled();
  });

  it.each([
    { href: "https://other.test/" },
    { target: "_blank" },
    { covered: true },
    { emptyHit: true },
    { rect: { left: -80, top: 10, right: -10, bottom: 40 } },
    { rect: { left: 10, top: 900, right: 80, bottom: 930 } },
    { rect: { left: 10, top: 10, right: 10, bottom: 40 } },
  ])("rejects an unavailable or different-authority target %j", (options) => {
    expect(actionableInternalAnchor(anchor(options).element)).toBe(false);
  });

  it("hit-tests the visible viewport intersection for a partially clipped internal link", () => {
    const { element, hitTest } = anchor({
      rect: { left: -20, top: 10, right: 80, bottom: 40 },
    });
    expect(actionableInternalAnchor(element)).toBe(true);
    expect(hitTest).toHaveBeenCalledWith(40, 25);
  });
});
