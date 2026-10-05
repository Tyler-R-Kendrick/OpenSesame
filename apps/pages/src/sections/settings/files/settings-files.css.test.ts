/**
 * The file viewer's two layout rules are not covered by a browser gate
 * (`verify:mobile` does not open a settings file), and a stylesheet edit once
 * dropped them: on a phone the file list and the open file sat side by side,
 * and the rows fell under the 44px touch floor. A stylesheet cannot be run in
 * a unit test, so this reads it.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(
  new URL("./settings-files.css", import.meta.url),
  "utf8",
);

/** The body of the first `@media` block whose query is `query`. */
function block(query: string): string {
  const at = css.indexOf(`@media ${query}`);
  if (at < 0) return "";
  const open = css.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "{") depth += 1;
    if (css[i] === "}") depth -= 1;
    if (depth === 0) return css.slice(open + 1, i);
  }
  return "";
}

describe("the file viewer's layout rules", () => {
  it("stacks the list above the open file on a narrow screen", () => {
    expect(block("(max-width: 900px)")).toMatch(
      /\.vfiles\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/,
    );
  });

  it("keeps a file row at the 44px touch floor", () => {
    expect(block("(pointer: coarse), (max-width: 900px)")).toMatch(
      /\.vfiles__file[\s\S]*min-height:\s*2\.75rem/,
    );
  });
});
