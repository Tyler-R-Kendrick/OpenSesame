/**
 * What the browser entry must carry (ADR 0086).
 *
 * `apps/pages` aliases `@opensesame/os-domain` straight to `browser.ts`
 * (`apps/pages/vite.config.ts`), so anything a browser surface needs and this
 * entry does not export resolves to `undefined` in the bundle.
 *
 * For most values that is a loud failure the first time somebody calls one.
 * For `FORBIDDEN_URL_PARAMS` it is silent and inverted: consumers build a Set
 * from it, an absent list becomes an empty Set, and an empty deny-list means
 * *nothing is forbidden*. The one check standing between a link builder and a
 * bearer in a URL would stop checking on exactly the surface with the most
 * link builders, and every test would still pass — because the tests import
 * from the Node entry, where the list is present.
 *
 * That already happened once. This file is the guard against it happening
 * again.
 */

import { describe, expect, it } from "vitest";
import * as browser from "../browser.js";
import * as node from "../index.js";

describe("the browser entry", () => {
  it("carries a non-empty forbidden-parameter list", () => {
    expect(Array.isArray(browser.FORBIDDEN_URL_PARAMS)).toBe(true);
    expect(browser.FORBIDDEN_URL_PARAMS.length).toBeGreaterThan(0);
  });

  it("agrees with the Node entry about what is forbidden", () => {
    // Two deny-lists that could drift would be worse than one, because the
    // surface with the weaker list is the one nobody tests.
    expect([...browser.FORBIDDEN_URL_PARAMS]).toEqual([
      ...node.FORBIDDEN_URL_PARAMS,
    ]);
  });

  it("carries the interaction machine and its types", () => {
    expect(browser.interactionMachine.approve).toBeInstanceOf(Function);
    expect(browser.interactionMachine.isTerminal).toBeInstanceOf(Function);
  });

  it("carries the card-data refusal, which browsers need too", () => {
    // A surface that renders a transaction can also be the one that builds it.
    expect(() =>
      browser.assertNoPaymentCredentials({ pan: "4111111111111111" }),
    ).toThrow();
  });

  it("pulls no node:crypto helper into a browser bundle", () => {
    // The reference MAC and the request digest are server-side by design:
    // minting either needs a deployment pepper, and a pepper in a bundle is
    // a pepper on every device that loaded the page.
    expect("mintInteractionRef" in browser).toBe(false);
    expect("canonicalRequestDigest" in browser).toBe(false);
    expect("mintInteractionRef" in node).toBe(true);
    expect("canonicalRequestDigest" in node).toBe(true);
  });
});
