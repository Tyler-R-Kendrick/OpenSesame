import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
/** The recording hairline is the only sign the timer is running (ADR 0155). */
import { describe, expect, it } from "vitest";

function reducedMotionBlock(source: string): string {
  const start = source.indexOf("@media (prefers-reduced-motion: reduce)");
  if (start === -1) throw new Error("no reduced-motion block");
  const end = source.indexOf("\n}\n", start);
  return source.slice(start, end);
}

const css = readFileSync(
  fileURLToPath(new URL("./keybindings.css", import.meta.url)),
  "utf8",
);

describe("the key-capture drain under reduced motion", () => {
  const block = reducedMotionBlock(css);
  const drain = /\.kb-capture__drain\s*\{([^}]*)\}/.exec(block)?.[1] ?? "";

  it("still runs, so the timeout stays visible while the timer commits", () => {
    expect(drain).not.toBe("");
    expect(drain).not.toMatch(/animation:\s*none/);
    expect(drain).not.toMatch(/animation-name:\s*none/);
  });

  it("moves in steps instead of a continuous glide", () => {
    expect(drain).toMatch(/animation-timing-function:\s*steps\(\s*[2-9]/);
  });
});
