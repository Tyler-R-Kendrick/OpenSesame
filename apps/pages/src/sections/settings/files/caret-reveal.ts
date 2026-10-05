/**
 * Keeping the caret in view in the painted editor. The textarea never scrolls
 * itself (the stage scrolls sideways, the page scrolls down), and the grid
 * track it sits in takes its size from the painted copy, which React rewrites
 * after the browser has already tried to reveal the caret. So after a large
 * insert the caret can be off-screen; `revealCaret` finds it in the painted
 * copy and scrolls the stage and the page only as far as it must.
 */

export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface Delta {
  x: number;
  y: number;
}

function axisDelta(
  start: number,
  end: number,
  boxStart: number,
  boxEnd: number,
  margin: number,
): number {
  if (start < boxStart + margin) return start - (boxStart + margin);
  if (end > boxEnd - margin) return end - (boxEnd - margin);
  return 0;
}

/** How far to scroll to bring `rect` inside `box` with `margin` to spare; zero
 * on an axis where it is already inside. A positive delta scrolls forward. */
export function revealDelta(rect: Box, box: Box, margin: Delta): Delta {
  return {
    x: axisDelta(rect.left, rect.right, box.left, box.right, margin.x),
    y: axisDelta(rect.top, rect.bottom, box.top, box.bottom, margin.y),
  };
}

function hasHeight(rect: Box | undefined): rect is Box {
  return rect !== undefined && rect.bottom - rect.top > 0;
}

/** The text node and offset of the character `offset` in `root`'s text. The
 * start of a node wins over the end of the one before it, so the start of a
 * line is found on that line. */
function textPosition(
  root: Node,
  offset: number,
): { node: Node; at: number } | undefined {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let seen = 0;
  let last: { node: Node; at: number } | undefined;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (offset < seen + length) return { node, at: offset - seen };
    last = { node, at: length };
    seen += length;
  }
  return last;
}

/** Where the caret at `offset` of the source is drawn in the painted copy. */
export function caretRect(pre: HTMLElement, offset: number): Box | undefined {
  const position = textPosition(pre, offset);
  if (position) {
    const range = document.createRange();
    range.setStart(position.node, position.at);
    range.collapse(true);
    // Not every DOM (a test's, an old engine's) can measure a range.
    const whole = range.getBoundingClientRect?.();
    if (hasHeight(whole)) return whole;
    const first = range.getClientRects?.()?.[0];
    if (hasHeight(first)) return first;
  }
  // A collapsed range on an empty line has no box; place it by its line.
  const text = pre.textContent ?? "";
  const line = text.slice(0, offset).split("\n").length - 1;
  const style = getComputedStyle(pre);
  const height = Number.parseFloat(style.lineHeight);
  if (!(height > 0)) return undefined;
  const origin = pre.getBoundingClientRect();
  const top =
    origin.top + (Number.parseFloat(style.paddingTop) || 0) + line * height;
  return { left: origin.left, right: origin.left, top, bottom: top + height };
}

function scrollsDown(element: Element): boolean {
  const overflow = getComputedStyle(element).overflowY;
  return (
    (overflow === "auto" || overflow === "scroll") &&
    element.scrollHeight > element.clientHeight
  );
}

/** The nearest ancestor that scrolls the page down, else the document. */
function verticalScroller(from: Element): Element | null {
  for (let at = from.parentElement; at; at = at.parentElement) {
    if (scrollsDown(at)) return at;
  }
  return document.scrollingElement ?? document.documentElement;
}

function viewBox(scroller: Element): Box {
  if (
    scroller === document.scrollingElement ||
    scroller === document.documentElement
  ) {
    const root = document.documentElement;
    return {
      left: 0,
      top: 0,
      right: root.clientWidth,
      bottom: root.clientHeight,
    };
  }
  const rect = scroller.getBoundingClientRect();
  return {
    left: rect.left,
    top: rect.top,
    right: rect.left + scroller.clientWidth,
    bottom: rect.top + scroller.clientHeight,
  };
}

/** The most the page's own chrome is allowed to cover: sticky bars are not
 * measured, so keep two lines clear of either edge. */
const LINES_CLEAR = 2;
const SIDE_CLEAR = 16;

/**
 * Bring the caret into view, and only when it is out of it — and only for a
 * person who is typing in `input` with a collapsed selection; never the focus
 * of anything else, and never a scroll that was not needed.
 */
export function revealCaret(
  stage: HTMLElement,
  pre: HTMLElement,
  input: HTMLTextAreaElement,
): void {
  if (document.activeElement !== input) return;
  if (input.selectionStart !== input.selectionEnd) return;
  const rect = caretRect(pre, input.selectionStart);
  if (!rect) return;
  const height = rect.bottom - rect.top;
  const frame = stage.getBoundingClientRect();
  const across = revealDelta(
    rect,
    {
      left: frame.left,
      right: frame.left + stage.clientWidth,
      top: Number.NEGATIVE_INFINITY,
      bottom: Number.POSITIVE_INFINITY,
    },
    { x: SIDE_CLEAR, y: 0 },
  );
  if (across.x !== 0) stage.scrollLeft += across.x;
  const scroller = verticalScroller(stage);
  if (!scroller) return;
  const down = revealDelta(rect, viewBox(scroller), {
    x: 0,
    y: LINES_CLEAR * height,
  });
  if (down.y !== 0) scroller.scrollTop += down.y;
}
