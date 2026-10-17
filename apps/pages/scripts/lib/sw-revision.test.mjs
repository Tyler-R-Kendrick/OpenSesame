import { describe, expect, it } from "vitest";
import { bumpShellRevision } from "./sw-revision.mjs";

describe("bumpShellRevision", () => {
  it("changes only the index.html revision, url first or revision first", () => {
    for (const entry of [
      '{"revision":"abc123","url":"index.html"}',
      '{"url":"index.html","revision":"abc123"}',
    ]) {
      const source = `self.__WB_MANIFEST=[${entry},{"revision":"abc123","url":"assets/app.js"}]`;
      const bumped = bumpShellRevision(source);
      expect(bumped.from).toBe("abc123");
      expect(bumped.to).not.toBe("abc123");
      expect(bumped.to).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
      expect(bumped.source).toContain(`"revision":"${bumped.to}"`);
      expect(bumped.source).toContain(
        '{"revision":"abc123","url":"assets/app.js"}',
      );
      expect(bumped.source).not.toContain(
        '"revision":"abc123","url":"index.html"',
      );
      expect(bumped.source).not.toContain(
        '"url":"index.html","revision":"abc123"',
      );
    }
  });

  it("skips a function that mentions index.html and edits the shell entry", () => {
    const source = `function C(t){return "index.html"===t.html}self.__WB_MANIFEST=[{"revision":"abc123","url":"index.html"},{"revision":"abc123","url":"assets/app.js"}]`;
    const bumped = bumpShellRevision(source);
    expect(bumped.from).toBe("abc123");
    expect(bumped.source).toContain(
      `"revision":"${bumped.to}","url":"index.html"`,
    );
    expect(bumped.source).toContain('return "index.html"===t.html');
    expect(bumped.source).toContain(
      '{"revision":"abc123","url":"assets/app.js"}',
    );
  });
});
