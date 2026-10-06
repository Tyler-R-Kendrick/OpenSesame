import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it } from "vitest";
import { resolveChromium } from "./browser.js";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0))
    rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "visual-browser-"));
  roots.push(root);
  return root;
}
function install(root: string, revision: number, layout: string) {
  const dir = join(root, `chromium-${revision}`, layout);
  mkdirSync(dir, { recursive: true });
  const path = join(dir, "chrome");
  writeFileSync(path, "fixture");
  return path;
}
it("selects the newest installed Chromium across both supported cache layouts", () => {
  const root = fixture();
  install(root, 1234, "chrome-linux");
  const latest = install(root, 1243, "chrome-linux64");
  expect(resolveChromium(undefined, join(root, "absent"), root)).toBe(latest);
});
it("uses explicit browser before pinned or cached choices and refuses missing explicit paths", () => {
  const root = fixture();
  const explicit = install(root, 1200, "chrome-linux");
  const pinned = install(root, 1243, "chrome-linux64");
  expect(resolveChromium(explicit, pinned, root)).toBe(explicit);
  expect(() => resolveChromium(join(root, "missing"), pinned, root)).toThrow(
    "PLAYWRIGHT_CHROMIUM",
  );
  expect(resolveChromium(undefined, pinned, root)).toBe(pinned);
});
