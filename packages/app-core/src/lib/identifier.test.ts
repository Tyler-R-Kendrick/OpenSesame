/** @vitest-environment jsdom */
/**
 * The identifier classifier: emails carry only their domain forward, slugs
 * pass the same grammar the tenant lookup enforces, and everything else is
 * unknown rather than guessed at.
 */

import { describe, expect, it } from "vitest";
import { classifyIdentifier } from "./identifier.js";

describe("classifyIdentifier", () => {
  it("classifies a work email and extracts only the domain", () => {
    expect(classifyIdentifier(" Sam@Acme.com ")).toEqual({
      kind: "email",
      email: "Sam@Acme.com",
      domain: "acme.com",
    });
  });

  it("classifies a slug, lowercased", () => {
    expect(classifyIdentifier("Acme-Corp")).toEqual({
      kind: "slug",
      slug: "acme-corp",
    });
  });

  it("answers unknown for an empty value", () => {
    expect(classifyIdentifier("   ")).toEqual({ kind: "unknown" });
  });

  it("answers unknown for an email with a junk domain", () => {
    expect(classifyIdentifier("sam@nope")).toEqual({ kind: "unknown" });
  });

  it("answers unknown for a value that is neither email nor slug", () => {
    expect(classifyIdentifier("two words")).toEqual({ kind: "unknown" });
  });
});
