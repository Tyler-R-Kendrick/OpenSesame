/** @vitest-environment jsdom */

import { afterEach, describe, expect, it, vi } from "vitest";
import {
  mountGuideTarget,
  observeGuideTarget,
  reportGuideActivation,
} from "./targets.js";

function attached(): HTMLAnchorElement {
  const element = document.createElement("a");
  document.body.append(element);
  return element;
}

/** Whether a wait for `id` to be activated has settled, after the microtasks. */
async function activated(id: "vault.import", act: () => void) {
  const settled = vi.fn();
  const controller = new AbortController();
  void observeGuideTarget(id, "activate", controller.signal)
    .then(settled)
    .catch(() => undefined);
  act();
  await Promise.resolve();
  await Promise.resolve();
  controller.abort();
  return settled.mock.calls.length > 0;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("how a guide target is activated", () => {
  it("is a click on its element by default", async () => {
    const element = attached();
    const detach = mountGuideTarget("vault.import", element);
    expect(await activated("vault.import", () => element.click())).toBe(true);
    detach();
  });

  it("is only what its own code reports when it is mounted manual", async () => {
    const element = attached();
    const detach = mountGuideTarget("vault.import", element, {
      activation: "manual",
    });
    // A tap on the Add button does something else, so it is not the slide.
    expect(await activated("vault.import", () => element.click())).toBe(false);
    expect(
      await activated("vault.import", () =>
        reportGuideActivation("vault.import"),
      ),
    ).toBe(true);
    detach();
  });
});
