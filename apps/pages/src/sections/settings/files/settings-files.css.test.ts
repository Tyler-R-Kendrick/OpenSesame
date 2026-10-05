/**
 * The file viewer's layout rules are not covered by a browser gate
 * (`verify:mobile` does not open a settings file), and a stylesheet edit once
 * dropped them: on a phone the file list and the open file sat side by side,
 * and the rows fell under the 44px touch floor. A stylesheet cannot be run in
 * a unit test, so this parses it — comments stripped, rules matched by their
 * exact selector list inside the exact `@media` query — and a negative control
 * shows the matcher fails on a rule that is commented out or has moved.
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

interface Node {
  /** The selector list or the at-rule prelude, blanks collapsed. */
  prelude: string;
  /** Declarations, for a rule. */
  body: string;
  /** Nested rules, for an at-rule. */
  children: Node[];
}

function read(relative: string): string {
  return readFileSync(new URL(relative, import.meta.url), "utf8");
}

function parse(css: string): Node[] {
  const nodes: Node[] = [];
  let from = 0;
  while (from < css.length) {
    const open = css.indexOf("{", from);
    if (open < 0) break;
    let depth = 0;
    let close = open;
    for (; close < css.length; close += 1) {
      if (css[close] === "{") depth += 1;
      if (css[close] === "}") depth -= 1;
      if (depth === 0) break;
    }
    const inner = css.slice(open + 1, close);
    const nested = inner.includes("{");
    nodes.push({
      prelude: css.slice(from, open).trim().replace(/\s+/g, " "),
      body: nested ? "" : inner,
      children: nested ? parse(inner) : [],
    });
    from = close + 1;
  }
  return nodes;
}

function sheet(css: string): Node[] {
  return parse(css.replace(/\/\*[\s\S]*?\*\//g, ""));
}

/** The declarations of the rule `selectors` inside `@media <query>`, or
 * `undefined` where there is none (top level when `query` is omitted). */
function declarations(
  nodes: Node[],
  selectors: string,
  query?: string,
): string | undefined {
  const scope =
    query === undefined
      ? nodes
      : nodes
          .filter((node) => node.prelude === `@media ${query}`)
          .flatMap((node) => node.children);
  return scope.find((node) => node.prelude === selectors)?.body;
}

const STACK = [".vfiles", "(max-width: 900px)"] as const;
const FLOOR = [
  ".vfiles__file, .vfiles__dirname",
  "(pointer: coarse), (max-width: 900px)",
] as const;

function stacks(nodes: Node[]): boolean {
  return /grid-template-columns:\s*minmax\(0,\s*1fr\)\s*;?\s*$/.test(
    declarations(nodes, ...STACK)?.trim() ?? "",
  );
}

function holdsFloor(nodes: Node[]): boolean {
  return /(^|[;\s])min-height:\s*2\.75rem\s*(;|$)/.test(
    declarations(nodes, ...FLOOR) ?? "",
  );
}

describe("the file viewer's layout rules", () => {
  const files = sheet(read("./settings-files.css"));

  it("stacks the list above the open file on a narrow screen", () => {
    expect(stacks(files)).toBe(true);
  });

  it("keeps a file row and a directory row at the 44px touch floor", () => {
    expect(holdsFloor(files)).toBe(true);
  });
});

describe("the layout guard's matcher", () => {
  const good = `
    @media (max-width: 900px) { .vfiles { grid-template-columns: minmax(0, 1fr); } }
    @media (pointer: coarse), (max-width: 900px) {
      .vfiles__file,
      .vfiles__dirname { min-height: 2.75rem; }
    }`;

  it("passes the rules as written", () => {
    expect(stacks(sheet(good))).toBe(true);
    expect(holdsFloor(sheet(good))).toBe(true);
  });

  it("fails when a rule is commented out", () => {
    const stacked = good.replace(
      /@media \(max-width: 900px\) \{(.*)\}/,
      "/* @media (max-width: 900px) {$1} */",
    );
    const floored = good.replace(
      "min-height: 2.75rem;",
      "/* min-height: 2.75rem; */",
    );
    expect(stacks(sheet(stacked))).toBe(false);
    expect(holdsFloor(sheet(floored))).toBe(false);
  });

  it("fails when a rule moves to another selector or another query", () => {
    expect(stacks(sheet(good.replace(".vfiles {", ".vfiles__open {")))).toBe(
      false,
    );
    expect(
      holdsFloor(sheet(good.replace(".vfiles__dirname {", ".vfiles__other {"))),
    ).toBe(false);
    expect(
      holdsFloor(
        sheet(
          good.replace(
            "(pointer: coarse), (max-width: 900px)",
            "(pointer: coarse)",
          ),
        ),
      ),
    ).toBe(false);
    expect(
      stacks(sheet(".vfiles { grid-template-columns: minmax(0, 1fr); }")),
    ).toBe(false);
  });
});

describe("the painted editor's rules", () => {
  const settings = sheet(read("../../settings.css"));

  it("draws its focus cue on the stage, since the textarea paints nothing", () => {
    expect(declarations(settings, ".set-raw__stage")).toMatch(
      /border-bottom:\s*1px solid var\(--line\)/,
    );
    expect(declarations(settings, ".set-raw__stage:focus-within")).toMatch(
      /border-bottom-color:\s*var\(--ink\)/,
    );
  });

  it("sizes both layers from one property that reads the field floor", () => {
    expect(declarations(settings, ".set-raw__stage")).toMatch(
      /--set-raw-size:\s*max\(0\.8125rem,\s*var\(--field-min\)\)/,
    );
    expect(declarations(settings, ".set-raw__paint, .set-raw__input")).toMatch(
      /font-size:\s*var\(--set-raw-size\)/,
    );
  });
});
