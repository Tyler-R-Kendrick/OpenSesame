/** @vitest-environment jsdom */
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PaintedText } from "./PaintedText.js";
import { longestLine } from "./lines.js";
import { paintSource, traceLinePaints } from "./paint.js";

/** The classes a painter put on each token, with the token's text. */
function painted(language: "yaml" | "json" | "toml", source: string) {
  const { container } = render(<pre>{paintSource(language, source)}</pre>);
  return {
    text: container.textContent,
    spans: [...container.querySelectorAll("span[class]")].map(
      (span) => `${span.className}:${span.textContent}`,
    ),
  };
}

describe("painting a settings file", () => {
  it("keeps every character of the text, whatever the language, and ends on a newline so the painted copy is as tall as the textarea", () => {
    const yaml = '# note\ntheme: "dark"\nitems:\n  - a\n  - 3 # three\n';
    const json = '{\n  "a": [1, true, null],\n  "b": "x\\"y"\n}\n';
    expect(painted("yaml", yaml).text).toBe(`${yaml}\n`);
    expect(painted("json", json).text).toBe(`${json}\n`);
    expect(painted("toml", yaml).text).toBe(`${yaml}\n`);
  });

  it("colours yaml keys, values, list items and comments", () => {
    const { spans } = painted(
      "yaml",
      "# note\nlockOnHide: false\nautoLock: 30\nselectedOptional:\n  - access.authority\n",
    );
    expect(spans).toContain("set-raw__comment:# note");
    expect(spans).toContain("set-raw__key:lockOnHide");
    expect(spans).toContain("set-raw__bool: false");
    expect(spans).toContain("set-raw__num: 30");
    expect(spans).toContain("set-raw__str:access.authority");
  });

  it("paints a list item's `key: value` as a key and a value, and a scalar item as a value", () => {
    const { spans, text } = painted(
      "yaml",
      "items:\n  - id: foo\n    name: x\n  - access.authority\n  - 3 # c\n  - http://x\n  - flag:\n",
    );
    expect(spans).toContain("set-raw__key:id");
    expect(spans).toContain("set-raw__str: foo");
    expect(spans).toContain("set-raw__str:access.authority");
    expect(spans).toContain("set-raw__num:3");
    expect(spans).toContain("set-raw__comment: # c");
    expect(spans).toContain("set-raw__str:http://x");
    expect(spans).toContain("set-raw__key:flag");
    expect(spans).not.toContain("set-raw__str:id: foo");
    expect(text).toContain("  - id: foo\n");
  });

  it("colours json keys, strings, numbers and literals", () => {
    const { spans } = painted(
      "json",
      '{ "id": "x", "n": -1.5e2, "on": true, "off": null }',
    );
    expect(spans).toContain('set-raw__key:"id"');
    expect(spans).toContain('set-raw__str:"x"');
    expect(spans).toContain("set-raw__num:-1.5e2");
    expect(spans).toContain("set-raw__bool:true");
    expect(spans).toContain("set-raw__bool:null");
  });

  it("does not take a colon inside a json string for a key", () => {
    const { spans } = painted("json", '{ "url": "https://x.example/a:b" }');
    expect(spans).toContain('set-raw__str:"https://x.example/a:b"');
  });

  it("keeps every character of a malformed json line, and paints an unterminated string to the end", () => {
    const line = '{ "a": "unterminated \\" , 12abc, -, nulls, true';
    const { text, spans } = painted("json", line);
    expect(text).toBe(`${line}\n`);
    expect(spans).toContain(
      'set-raw__str:"unterminated \\" , 12abc, -, nulls, true',
    );
    expect(painted("json", "-").spans).toEqual([]);
    expect(painted("json", "nulls truest").spans).toEqual([]);
    expect(painted("json", "[true,null]").spans).toEqual([
      "set-raw__bool:true",
      "set-raw__bool:null",
    ]);
  });

  it("leaves a language with no painter plain", () => {
    expect(painted("toml", "a = 1\n").spans).toEqual([]);
  });
});

describe("the painted editor", () => {
  it("draws the painted copy under the textarea that owns the keys", () => {
    const { container } = render(
      <PaintedText language="yaml" path="a.yaml" source={"k: true\n"} />,
    );
    const stage = container.querySelector(".set-raw__stage");
    expect(
      stage?.querySelector("pre[aria-hidden='true'] .set-raw__key"),
    ).toBeTruthy();
    expect(stage?.querySelector("textarea[aria-label='a.yaml']")).toBeTruthy();
  });

  it("widens to the longest line, so a long line scrolls the stage", () => {
    const { container } = render(
      <PaintedText
        language="json"
        path="a.json"
        source={`ab\n${"x".repeat(120)}\n`}
      />,
    );
    const stage = container.querySelector<HTMLElement>(".set-raw__stage");
    expect(stage?.style.getPropertyValue("--cols")).toBe("120");
  });

  it("marks a read-only file for the quieter ink", () => {
    const { container } = render(
      <PaintedText language="json" path="a.json" source="{}" readOnly />,
    );
    expect(container.querySelector(".set-raw__stage--ro")).toBeTruthy();
    expect(container.querySelector("textarea")?.readOnly).toBe(true);
  });
});

describe("painting a long or hostile line", () => {
  // A regular expression with a nested quantifier took seconds on this; the
  // scanner is linear. The bound is generous so a slow machine does not flake.
  const LIMIT_MS = 200;
  function paintMs(source: string): number {
    const started = performance.now();
    paintSource("json", source).length;
    return performance.now() - started;
  }

  it("paints 200KB of escaped quotes outside a string in linear time", () => {
    const hostile = '\\"'.repeat(100_000);
    expect(hostile.length).toBe(200_000);
    expect(paintMs(hostile)).toBeLessThan(LIMIT_MS);
    expect(painted("json", hostile).text).toBe(`${hostile}\n`);
  });

  it("paints 200KB of digits in linear time", () => {
    const digits = "1".repeat(200_000);
    expect(paintMs(digits)).toBeLessThan(LIMIT_MS);
    expect(painted("json", digits).spans).toEqual([`set-raw__num:${digits}`]);
  });

  it("finds the longest line of 200k lines without spreading them", () => {
    const text = `${"a\n".repeat(200_000)}${"b".repeat(7)}`;
    expect(longestLine(text)).toBe(7);
    expect(longestLine("")).toBe(0);
    expect(longestLine("ab\ncde\n")).toBe(3);
  });

  it("sizes the editor over 200k lines", () => {
    const text = "a\n".repeat(200_000);
    const { container } = render(
      <PaintedText
        language="toml"
        path="a.toml"
        source={text}
        painter={() => []}
      />,
    );
    const stage = container.querySelector<HTMLElement>(".set-raw__stage");
    expect(stage?.style.getPropertyValue("--cols")).toBe("1");
    expect(container.querySelector("textarea")?.value).toBe(text);
  });
});

describe("repainting as a person types", () => {
  afterEach(() => traceLinePaints(undefined));

  it("paints again only the line that changed", () => {
    const lines = Array.from({ length: 50 }, (_, n) => `k${n}: ${n}`);
    const painted: string[] = [];
    traceLinePaints((_, line) => painted.push(line));
    const view = render(
      <PaintedText language="yaml" path="a.yaml" source={lines.join("\n")} />,
    );
    expect(painted).toHaveLength(50);
    painted.length = 0;
    const edited = [...lines];
    edited[20] = "k20: 2000";
    view.rerender(
      <PaintedText language="yaml" path="a.yaml" source={edited.join("\n")} />,
    );
    expect(painted).toEqual(["k20: 2000"]);
    expect(view.container.querySelector("pre")?.textContent).toBe(
      `${edited.join("\n")}\n`,
    );
  });

  it("paints every line again when the language changes", () => {
    const painted: string[] = [];
    traceLinePaints((_, line) => painted.push(line));
    const view = render(
      <PaintedText language="yaml" path="a" source={"a: 1\nb: 2"} />,
    );
    painted.length = 0;
    view.rerender(
      <PaintedText language="json" path="a" source={"a: 1\nb: 2"} />,
    );
    expect(painted).toHaveLength(2);
  });
});
