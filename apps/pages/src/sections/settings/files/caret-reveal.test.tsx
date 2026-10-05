/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { PaintedText } from "./PaintedText.js";
import { type Box, revealCaret, revealDelta } from "./caret-reveal.js";

const BOX = { left: 0, top: 0, right: 100, bottom: 200 };
const MARGIN = { x: 10, y: 40 };

function rect(left: number, top: number, width = 0, height = 20) {
  return { left, top, right: left + width, bottom: top + height };
}

describe("revealDelta", () => {
  it("is zero for a caret already inside, margin and all", () => {
    expect(revealDelta(rect(50, 100), BOX, MARGIN)).toEqual({ x: 0, y: 0 });
    expect(revealDelta(rect(10, 40), BOX, MARGIN)).toEqual({ x: 0, y: 0 });
  });

  it("scrolls forward by just enough past the far edge", () => {
    expect(revealDelta(rect(400, 100), BOX, MARGIN)).toEqual({ x: 310, y: 0 });
    expect(revealDelta(rect(50, 500), BOX, MARGIN)).toEqual({ x: 0, y: 360 });
  });

  it("scrolls back past the near edge", () => {
    expect(revealDelta(rect(-30, -50), BOX, MARGIN)).toEqual({
      x: -40,
      y: -90,
    });
  });

  it("keeps a clear margin from the edge, for chrome that covers it", () => {
    expect(revealDelta(rect(95, 150), BOX, MARGIN)).toEqual({ x: 5, y: 10 });
  });
});

/** jsdom's Range cannot be measured; say what a browser would. */
function measureRanges(box: Box) {
  Object.defineProperty(Range.prototype, "getBoundingClientRect", {
    value: () => box,
    configurable: true,
  });
}

function place(element: HTMLElement, box: Box) {
  Object.defineProperty(element, "getBoundingClientRect", {
    value: () => box,
    configurable: true,
  });
}

function viewport(height: number) {
  Object.defineProperty(document.documentElement, "clientHeight", {
    value: height,
    configurable: true,
  });
}

/** jsdom has no layout: say where the browser would have drawn each thing. */
function layout(caret: ReturnType<typeof rect>, stageWidth = 100) {
  measureRanges(caret);
  const stage = document.querySelector<HTMLElement>(".set-raw__stage");
  if (!stage) throw new Error("no stage");
  place(stage, rect(0, 0, stageWidth, 400));
  Object.defineProperty(stage, "clientWidth", { value: stageWidth });
  viewport(800);
  return stage;
}

afterEach(() => {
  cleanup();
  Reflect.deleteProperty(Range.prototype, "getBoundingClientRect");
  document.documentElement.scrollTop = 0;
});

function mount(source: string) {
  const view = render(
    <PaintedText language="json" path="a.json" source={source} />,
  );
  const textarea = view.container.querySelector("textarea");
  if (!textarea) throw new Error("no textarea");
  return { view, textarea };
}

describe("revealing the caret after the painted copy grows", () => {
  it("scrolls the stage sideways when the caret fell past its edge", () => {
    const { view, textarea } = mount("a");
    textarea.focus();
    const stage = layout(rect(500, 10));
    view.rerender(
      <PaintedText language="json" path="a.json" source={"x".repeat(200)} />,
    );
    expect(stage.scrollLeft).toBe(500 - (100 - 16));
  });

  it("scrolls the page when the caret fell below the viewport", () => {
    const { view, textarea } = mount("a");
    textarea.focus();
    layout(rect(10, 5000));
    view.rerender(
      <PaintedText language="json" path="a.json" source={"x\n".repeat(60)} />,
    );
    expect(document.documentElement.scrollTop).toBe(5020 - (800 - 40));
  });

  it("does nothing when the caret is already in view", () => {
    const { view, textarea } = mount("a");
    textarea.focus();
    const stage = layout(rect(40, 100));
    view.rerender(<PaintedText language="json" path="a.json" source={"xx"} />);
    expect(stage.scrollLeft).toBe(0);
    expect(document.documentElement.scrollTop).toBe(0);
  });

  it("never scrolls for a textarea that is not focused", () => {
    const { view, textarea } = mount("a");
    textarea.blur();
    const stage = layout(rect(500, 5000));
    view.rerender(
      <PaintedText language="json" path="a.json" source={"x".repeat(200)} />,
    );
    expect(stage.scrollLeft).toBe(0);
    expect(document.documentElement.scrollTop).toBe(0);
  });

  it("never scrolls while a range is selected", () => {
    const { view, textarea } = mount("abc");
    textarea.focus();
    const stage = layout(rect(500, 10));
    view.rerender(
      <PaintedText language="json" path="a.json" source={"abcdef"} />,
    );
    stage.scrollLeft = 0;
    textarea.setSelectionRange(0, 3);
    const pre = view.container.querySelector("pre");
    if (!pre) throw new Error("no pre");
    revealCaret(stage, pre, textarea);
    expect(stage.scrollLeft).toBe(0);
  });

  it("finds the caret on an empty line, where a range has no box", () => {
    const { view, textarea } = mount("a\n\nb");
    textarea.focus();
    textarea.setSelectionRange(2, 2);
    const none = rect(0, 0, 0, 0);
    measureRanges(none);
    const stage = view.container.querySelector<HTMLElement>(".set-raw__stage");
    const pre = view.container.querySelector<HTMLElement>("pre");
    if (!stage || !pre) throw new Error("no editor");
    place(pre, rect(0, 200, 50, 400));
    viewport(270);
    pre.style.lineHeight = "20px";
    pre.style.paddingTop = "10px";
    revealCaret(stage, pre, textarea);
    // Line index 1 sits at 200 + 10 + 20 = 230..250; the viewport is 270 tall
    // with two lines (40px) kept clear, so the page moves forward by 20.
    expect(document.documentElement.scrollTop).toBe(20);
  });
});
