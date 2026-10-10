/** @vitest-environment jsdom */
import { cleanup, render } from "@testing-library/react";
import { createRef } from "react";
import { afterEach, describe, expect, it } from "vitest";
import { CipherDial } from "./CipherDial.js";
import { PLAIN, RING_COUNT } from "./constants.js";
import { computeDialLayout } from "./layout.js";
import { alignRings } from "./ring-motion.js";

afterEach(cleanup);

describe("computeDialLayout", () => {
  it("places eleven rings on the column divider in wide layout", () => {
    const layout = computeDialLayout({
      w: 1200,
      h: 800,
      card: { x: 80, y: 40, w: 400, h: 500 },
      notes: { x: 600, y: 0, w: 600, h: 800 },
      narrow: false,
      nowMs: 0,
    });
    expect(layout.rings).toHaveLength(RING_COUNT);
    expect(layout.cx).toBe(600);
    expect(PLAIN.startsWith("OPEN")).toBe(true);
    // Notes are not a quiet zone on wide — rings meet the divider.
    expect(layout.quiet).toEqual([{ x: 80, y: 40, w: 400, h: 500 }]);
  });

  it("never quiets the notes pane — opaque notes sit above the dial", () => {
    const notes = { x: 0, y: 520, w: 390, h: 280 };
    const card = { x: 20, y: 40, w: 350, h: 420 };
    const wide = computeDialLayout({
      w: 1200,
      h: 800,
      card,
      notes,
      narrow: false,
      nowMs: 0,
    });
    const phone = computeDialLayout({
      w: 390,
      h: 800,
      card,
      notes,
      narrow: true,
      nowMs: 0,
    });
    expect(wide.quiet).toEqual([card]);
    expect(phone.quiet).toEqual([card]);
    // Narrow corner dial stays in the empty band (lock-v5-mobile geometry).
    expect(phone.cx).toBe(-18);
    expect(phone.cy).toBeGreaterThan(card.y + card.h);
  });
});

describe("alignRings", () => {
  it("schedules staggered motion toward each ring target", () => {
    const layout = computeDialLayout({
      w: 800,
      h: 600,
      card: { x: 40, y: 20, w: 320, h: 400 },
      notes: { x: 400, y: 0, w: 400, h: 600 },
      narrow: false,
      nowMs: 0,
    });
    alignRings(layout.rings, 1000, 780);
    expect(layout.rings[0].t0).toBe(1000);
    expect(layout.rings.at(-1)?.dur).toBeGreaterThan(layout.rings[0].dur);
  });
});

describe("CipherDial", () => {
  it("renders decorative canvases", () => {
    const paneRef = createRef<HTMLDivElement>();
    const cardRef = createRef<HTMLDivElement>();
    const notesRef = createRef<HTMLElement>();
    const { container } = render(
      <div ref={paneRef} style={{ width: 400, height: 300 }}>
        <div ref={cardRef} style={{ width: 200, height: 200 }} />
        <CipherDial
          paneRef={paneRef}
          cardRef={cardRef}
          notesRef={notesRef}
          phase="idle"
          alignStartMs={null}
          lit={0}
        />
      </div>,
    );
    expect(container.querySelector(".cipher-dial")).toBeTruthy();
    expect(container.querySelectorAll("canvas").length).toBeGreaterThan(2);
  });
});
