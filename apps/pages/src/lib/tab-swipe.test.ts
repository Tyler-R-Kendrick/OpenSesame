/** @vitest-environment jsdom */
/**
 * One finger swiped sideways turns a page's tabs. These drive the touch
 * handlers with real touch sequences over real markup, never a handler spy.
 */
import { overlapCast } from "@opensesame/os-domain";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTabSwipe, swipeTabs } from "./tab-swipe.js";

type Finger = { id: number; x: number; y: number; target: EventTarget };

function touchEvent(
  type: string,
  fingers: readonly Finger[],
  changed: readonly Finger[],
): TouchEvent {
  const event = new Event(type, { bubbles: true, cancelable: true });
  const list = (items: readonly Finger[]) =>
    items.map((f) => ({
      identifier: f.id,
      clientX: f.x,
      clientY: f.y,
      target: f.target,
    }));
  Object.defineProperty(event, "touches", { value: list(fingers) });
  Object.defineProperty(event, "changedTouches", { value: list(changed) });
  return overlapCast<Event, TouchEvent>(event);
}

/** An element the markup was written with; a missing one is the test's bug. */
function el(id: string): HTMLElement {
  const found = document.getElementById(id);
  if (!found) throw new Error(`no #${id}`);
  return found;
}

let clock = 0;
const swiper = () => createTabSwipe(() => clock);

/** One finger lands on `target`, travels by `by`, and lifts `ms` later. */
function drag(
  h: ReturnType<typeof swiper>,
  target: EventTarget,
  by: readonly [number, number],
  ms = 150,
) {
  const at = { id: 1, x: 200, y: 300, target };
  h.down(touchEvent("touchstart", [at], [at]));
  clock += ms;
  const lifted = { ...at, x: at.x + by[0], y: at.y + by[1] };
  h.up(touchEvent("touchend", [], [lifted]));
}

/** A strip of three tabs with the second selected, and the page under it. */
function page(markup = "") {
  document.body.innerHTML = `
    <main>
      <div role="tablist" aria-label="Views">
        <button role="tab" aria-selected="false" id="a">A</button>
        <button role="tab" aria-selected="true" id="b">B</button>
        <button role="tab" aria-selected="false" id="c">C</button>
      </div>
      <section id="body"><p id="text">Page</p>${markup}</section>
    </main>`;
  const clicks: string[] = [];
  for (const id of ["a", "b", "c"])
    document
      .getElementById(id)
      ?.addEventListener("click", () => clicks.push(id));
  return { clicks, text: el("text") };
}

afterEach(() => {
  document.body.innerHTML = "";
  clock = 0;
  vi.restoreAllMocks();
});

describe("swiping a page with tabs", () => {
  it("turns to the next tab on a swipe left and the previous on a swipe right", () => {
    const { clicks, text } = page();
    const h = swiper();
    drag(h, text, [-120, 4]);
    drag(h, text, [120, -4]);
    expect(clicks).toEqual(["c", "a"]);
  });

  it("does not wrap past either end", () => {
    const { clicks, text } = page();
    document.getElementById("b")?.setAttribute("aria-selected", "false");
    document.getElementById("a")?.setAttribute("aria-selected", "true");
    drag(swiper(), text, [120, 0]);
    expect(clicks).toEqual([]);
    document.getElementById("a")?.setAttribute("aria-selected", "false");
    document.getElementById("c")?.setAttribute("aria-selected", "true");
    drag(swiper(), text, [-120, 0]);
    expect(clicks).toEqual([]);
  });

  it("is not a swipe when it is short, slow, slanted or a scroll", () => {
    const { clicks, text } = page();
    const h = swiper();
    drag(h, text, [-40, 0]);
    drag(h, text, [-120, 0], 2000);
    drag(h, text, [-120, 60]);
    drag(h, text, [-90, -60]);
    expect(clicks).toEqual([]);
  });

  it("is spoiled by a second finger", () => {
    const { clicks, text } = page();
    const h = swiper();
    const one = { id: 1, x: 200, y: 300, target: text };
    const two = { id: 2, x: 240, y: 300, target: text };
    h.down(touchEvent("touchstart", [one], [one]));
    h.down(touchEvent("touchstart", [one, two], [two]));
    clock += 150;
    h.up(touchEvent("touchend", [two], [{ ...one, x: 40 }]));
    h.up(touchEvent("touchend", [], [{ ...two, x: 80 }]));
    expect(clicks).toEqual([]);
  });

  it("skips tabs that are disabled or hidden", () => {
    const { clicks, text } = page();
    document.getElementById("c")?.setAttribute("disabled", "");
    drag(swiper(), text, [-120, 0]);
    expect(clicks).toEqual([]);
    document.getElementById("c")?.removeAttribute("disabled");
    document.getElementById("c")?.setAttribute("hidden", "");
    document.getElementById("a")?.setAttribute("aria-disabled", "true");
    drag(swiper(), text, [-120, 0]);
    drag(swiper(), text, [120, 0]);
    expect(clicks).toEqual([]);
  });

  it("reads Settings' and Wallet's strip of links, whose current one is aria-current", () => {
    document.body.innerHTML = `
      <main>
        <nav class="set__nav">
          <a class="set__nav-link" id="x" href="#x">X</a>
          <a class="set__nav-link" id="y" href="#y" aria-current="page">Y</a>
          <a class="set__nav-link" id="z" href="#z">Z</a>
        </nav>
        <p id="text">Page</p>
      </main>`;
    const clicks: string[] = [];
    for (const id of ["x", "y", "z"])
      document.getElementById(id)?.addEventListener("click", (e) => {
        e.preventDefault();
        clicks.push(id);
      });
    drag(swiper(), el("text"), [-120, 0]);
    expect(clicks).toEqual(["z"]);
  });

  it("turns the inner tabs when the finger is below them, the outer above", () => {
    document.body.innerHTML = `
      <main>
        <div role="tablist"><button role="tab" aria-selected="true" id="o1">1</button><button role="tab" aria-selected="false" id="o2">2</button></div>
        <p id="between">Between</p>
        <div role="tablist"><button role="tab" aria-selected="true" id="i1">1</button><button role="tab" aria-selected="false" id="i2">2</button></div>
        <p id="inner">Inner</p>
      </main>`;
    const clicks: string[] = [];
    for (const id of ["o2", "i2"])
      document
        .getElementById(id)
        ?.addEventListener("click", () => clicks.push(id));
    const h = swiper();
    drag(h, el("between"), [-120, 0]);
    drag(h, el("inner"), [-120, 0]);
    expect(clicks).toEqual(["o2", "i2"]);
  });

  it("hands a swipe to the outer tabs once the inner ones run out", () => {
    document.body.innerHTML = `
      <main>
        <div role="tablist"><button role="tab" aria-selected="false" id="o1">1</button><button role="tab" aria-selected="true">2</button><button role="tab" aria-selected="false" id="o3">3</button></div>
        <div role="tablist"><button role="tab" aria-selected="false" id="i1">1</button><button role="tab" aria-selected="true">2</button></div>
        <p id="inner">Inner</p>
      </main>`;
    const clicks: string[] = [];
    for (const id of ["o1", "o3", "i1"])
      document
        .getElementById(id)
        ?.addEventListener("click", () => clicks.push(id));
    const h = swiper();
    // Left: the inner strip is at its last tab, so the outer one turns on.
    drag(h, el("inner"), [-120, 0]);
    // Right: the inner strip has a tab before, which wins over the outer one.
    drag(h, el("inner"), [120, 0]);
    expect(clicks).toEqual(["o3", "i1"]);
  });

  it("does nothing above the strip, or where there is no strip", () => {
    document.body.innerHTML = `<main><h1 id="head">Head</h1><div role="tablist"><button role="tab" aria-selected="true">1</button><button role="tab" id="n">2</button></div></main>`;
    const clicked = vi.fn();
    document.getElementById("n")?.addEventListener("click", clicked);
    drag(swiper(), el("head"), [-120, 0]);
    document.body.innerHTML = `<main><p id="t">No tabs</p></main>`;
    drag(swiper(), el("t"), [-120, 0]);
    expect(clicked).not.toHaveBeenCalled();
  });

  describe("stands down where the drag is already something else's", () => {
    const cases: [string, string][] = [
      [
        "a listing's row (swiped left it asks for its actions)",
        `<div class="vtree__rows"><div id="from">row</div></div>`,
      ],
      ["the rail", `<div class="railtree"><div id="from">row</div></div>`],
      ["a text field", `<input id="from" type="text" />`],
      ["a textarea", `<textarea id="from"></textarea>`],
      ["a slider", `<div role="slider" id="from"></div>`],
      ["an editable region", `<div role="textbox" id="from">yaml</div>`],
    ];
    for (const [name, markup] of cases) {
      it(name, () => {
        const { clicks } = page(markup);
        drag(swiper(), el("from"), [-120, 0]);
        expect(clicks).toEqual([]);
      });
    }

    it("a text field that holds the keyboard, wherever the finger lands", () => {
      const { clicks, text } = page(`<input id="field" type="text" />`);
      el("field").focus();
      drag(swiper(), text, [-120, 0]);
      expect(clicks).toEqual([]);
    });

    it("something that scrolls sideways under the finger", () => {
      const { clicks } = page(
        `<div id="wide" style="overflow-x: auto"><p id="from">wide</p></div>`,
      );
      const wide = el("wide");
      Object.defineProperty(wide, "scrollWidth", { value: 900 });
      Object.defineProperty(wide, "clientWidth", { value: 300 });
      drag(swiper(), el("from"), [-120, 0]);
      expect(clicks).toEqual([]);
    });

    it("an open context menu", () => {
      const { clicks, text } = page(`<div class="ctxmenu" role="menu"></div>`);
      drag(swiper(), text, [-120, 0]);
      expect(clicks).toEqual([]);
    });

    it("a modal the finger is not in", () => {
      const { clicks, text } = page(
        `<div role="dialog" aria-modal="true"><p>Sheet</p></div>`,
      );
      drag(swiper(), text, [-120, 0]);
      expect(clicks).toEqual([]);
    });
  });

  it("turns the tabs of a modal when the finger is in it, and only those", () => {
    document.body.innerHTML = `
      <main>
        <div role="tablist"><button role="tab" aria-selected="true">page 1</button><button role="tab" id="page2">page 2</button></div>
      </main>
      <div role="dialog" aria-modal="true">
        <div role="tablist"><button role="tab" aria-selected="true">Ask</button><button role="tab" id="tutorials">Tutorials</button></div>
        <p id="inside">Sheet</p>
      </div>`;
    const clicks: string[] = [];
    for (const id of ["page2", "tutorials"])
      document
        .getElementById(id)
        ?.addEventListener("click", () => clicks.push(id));
    drag(swiper(), el("inside"), [-120, 0]);
    expect(clicks).toEqual(["tutorials"]);
  });

  it("never moves focus", () => {
    const { text } = page();
    const before = document.activeElement;
    expect(swipeTabs(text, 1)).toBe(true);
    expect(document.activeElement).toBe(before);
  });
});
