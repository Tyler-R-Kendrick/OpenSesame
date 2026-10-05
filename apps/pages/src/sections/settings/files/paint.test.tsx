/** @vitest-environment jsdom */
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PaintedText } from "./PaintedText.js";
import { paintSource } from "./paint.js";

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
    expect(
      (
        container.querySelector(".set-raw__stage") as HTMLElement
      ).style.getPropertyValue("--cols"),
    ).toBe("120");
  });

  it("marks a read-only file for the quieter ink", () => {
    const { container } = render(
      <PaintedText language="json" path="a.json" source="{}" readOnly />,
    );
    expect(container.querySelector(".set-raw__stage--ro")).toBeTruthy();
    expect(container.querySelector("textarea")?.readOnly).toBe(true);
  });
});
