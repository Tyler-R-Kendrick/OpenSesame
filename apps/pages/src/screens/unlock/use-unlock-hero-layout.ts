import { type RefObject, useLayoutEffect, useState } from "react";

/** Prototype lock-v5 hero: max em, gap above the card (wide / narrow). */
const MAX_EM = 90;
const GAP_WIDE = 34;
const GAP_NARROW = 20;
const NARROW_BP = 1100;
/**
 * Width of mark + `0PEN SESAME` in em — lock-v5.html
 * (`asc*1.25 + gapEm + NL*adv` ≈ 7.78 for OS Logo metrics with `includeMark`).
 */
const WORD_UNITS = 7.78;
/** Min gap from the hero's right edge to the notes column divider. */
const COL_MARGIN = 24;
/** Left inset used when sizing the wide hero (prototype `c.x + c.w - 40`). */
const WIDE_LEFT_INSET = 40;
/** Narrow pane top padding when no hero is reserved (unlock.css). */
const NARROW_BASE_PAD_TOP = 32;

export type UnlockHeroBox = {
  left: number;
  top: number;
  size: number;
};

/**
 * Place the unlock CipherWordmark as a hero above the card — the same fit as
 * lock-v5.html (`maxEm: 90`, wide right-aligned to the card, gap 34/20).
 * On wide, clamps to the left column so the hero never touches the notes
 * divider (margin ≥ {@link COL_MARGIN}). On narrow, grows the pane's top
 * padding so the hero sits on its own row above the brand tools.
 */
export function useUnlockHeroLayout(
  paneRef: RefObject<HTMLElement | null>,
  cardRef: RefObject<HTMLElement | null>,
  notesRef: RefObject<HTMLElement | null>,
): UnlockHeroBox {
  const [box, setBox] = useState<UnlockHeroBox>({
    left: 40,
    top: 24,
    size: 56,
  });

  useLayoutEffect(() => {
    const pane = paneRef.current;
    const card = cardRef.current;
    if (!pane || !card) return;

    const place = () => {
      const pr = pane.getBoundingClientRect();
      const narrow = pr.width < NARROW_BP;
      const gap = narrow ? GAP_NARROW : GAP_WIDE;

      // First pass: size from current card width (before padding nudge).
      let cr = card.getBoundingClientRect();
      let cardX = cr.left - pr.left;
      const cardRight = cardX + cr.width;

      let avail0: number;
      let alignRight: number;
      if (narrow) {
        avail0 = cr.width;
        alignRight = cardRight;
      } else {
        const notes = notesRef.current;
        const notesLeft = notes
          ? notes.getBoundingClientRect().left - pr.left
          : pr.width;
        // Clamp by the left column, not the viewport — stay clear of the divider.
        alignRight = Math.min(cardRight, notesLeft - COL_MARGIN);
        avail0 = Math.max(120, alignRight - WIDE_LEFT_INSET);
      }

      let size = Math.max(28, Math.min(MAX_EM, avail0 / WORD_UNITS));
      let width = size * WORD_UNITS;
      if (width > avail0) {
        size = avail0 / WORD_UNITS;
        width = avail0;
      }
      // Canvas plate height ≈ 1.25 * asc * em (asc < 1 for OS Logo); 1.05 covers
      // pad + measured glyph box without oversizing the reserved band.
      const height = size * 1.05;

      if (narrow) {
        // Reserve a band above the card for the hero (prototype paddingTop).
        pane.style.paddingTop = `${NARROW_BASE_PAD_TOP + height + gap}px`;
        const pr2 = pane.getBoundingClientRect();
        cr = card.getBoundingClientRect();
        cardX = cr.left - pr2.left;
        const cardY = cr.top - pr2.top;
        const left = cardX;
        const top = Math.max(8, cardY - gap - height);
        setBox({ left, top, size });
        return;
      }

      pane.style.paddingTop = "";
      const cardY = cr.top - pr.top;
      const left = alignRight - width;
      const top = Math.max(8, cardY - gap - height);
      setBox({ left, top, size });
    };

    place();
    if (globalThis.ResizeObserver === undefined) {
      return () => {
        pane.style.paddingTop = "";
      };
    }
    const ro = new ResizeObserver(place);
    ro.observe(pane);
    ro.observe(card);
    const notes = notesRef.current;
    if (notes) ro.observe(notes);
    return () => {
      ro.disconnect();
      pane.style.paddingTop = "";
    };
  }, [paneRef, cardRef, notesRef]);

  return box;
}
