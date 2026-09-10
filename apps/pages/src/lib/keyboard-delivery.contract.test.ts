import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const read = (path: string) =>
  readFileSync(new URL(path, import.meta.url), "utf8");

it("requires a built-page keyboard journey in the existing required CI job", () => {
  const workflow = read("../../../../.github/workflows/ci.yml");
  const bundle = workflow.split("  bundle:")[1]?.split("  rust:")[0];
  expect(bundle).toContain("pnpm --filter @opensesame/pages verify:keyboard");
  const manifest = JSON.parse(read("../../package.json"));
  expect(manifest.scripts["verify:keyboard"]).toBe(
    "node scripts/verify-keyboard.mjs",
  );
});

it("does not bypass keyboard arrival with pointer, focus injection or synthetic events", () => {
  const journey = read("../../scripts/verify-keyboard.mjs");
  expect(journey).not.toMatch(/\.(?:click|focus|dispatchEvent)\s*\(/);
  expect(journey).toContain("[1280, 390]");
  expect(journey).toContain('page.keyboard.press("Enter")');
  expect(journey).toContain(".toBeFocused()");
});
