import { describe, expect, it } from "vitest";
import {
  fnv1a,
  manifestFromBoundary,
  releaseIdFromManifest,
  shellEntry,
} from "./release.js";

describe("release id", () => {
  it("is the shell's revision when the manifest has one", () => {
    expect(
      releaseIdFromManifest([
        { url: "assets/main-abc.js", revision: null },
        { url: "index.html", revision: "0123abcd" },
      ]),
    ).toBe("0123abcd");
  });

  it("falls back to a manifest hash without a shell revision", () => {
    const id = releaseIdFromManifest([]);
    expect(id).toBe(`dev-${fnv1a("[]")}`);
    expect(id).not.toContain(":");
    expect(releaseIdFromManifest(["index.html"])).toMatch(/^dev-[0-9a-f]{8}$/);
  });

  it("refuses a revision that could break the cache-name grammar", () => {
    expect(
      releaseIdFromManifest([{ url: "index.html", revision: "a:b" }]),
    ).toMatch(/^dev-/);
  });

  it("is stable for the same manifest and differs across builds", () => {
    const a = releaseIdFromManifest([{ url: "assets/a-1.js", revision: null }]);
    const b = releaseIdFromManifest([{ url: "assets/a-2.js", revision: null }]);
    expect(a).toBe(
      releaseIdFromManifest([{ url: "assets/a-1.js", revision: null }]),
    );
    expect(a).not.toBe(b);
  });
});

describe("manifest narrowing", () => {
  it("keeps string and {url, revision} entries, drops the rest", () => {
    expect(
      manifestFromBoundary([
        "index.html",
        { url: "a.js", revision: "r" },
        { url: "b.js" },
        { revision: "x" },
        7,
        null,
      ]),
    ).toEqual([
      "index.html",
      { url: "a.js", revision: "r" },
      { url: "b.js", revision: null },
    ]);
    expect(manifestFromBoundary(undefined)).toEqual([]);
    expect(manifestFromBoundary({ url: "index.html" })).toEqual([]);
  });

  it("finds the shell in either entry form", () => {
    expect(shellEntry(["index.html"])).toBe("index.html");
    expect(shellEntry([{ url: "index.html", revision: "r" }])).toBe(
      "index.html",
    );
    expect(shellEntry([{ url: "auth/redirect.html", revision: "r" }])).toBe(
      null,
    );
  });
});
