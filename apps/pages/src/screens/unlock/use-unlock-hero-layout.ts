import { type RefObject, useLayoutEffect, useState } from "react";

/** Prototype lock-v5 hero: max em, gap above the card (wide / narrow). */
const MAX_EM = 90;
const GAP_WIDE = 34;
const GAP_NARROW = 20;
const NARROW_BP = 1100;
/**
 * Width of mark + `0PEN SESAME` in em — lock-v5.html
 * (`asc*1.25 + gapEm + NL*adv` ≈ 7 for Share Tech Mono / OS Logo metrics).
 * Mark is drawn inside CipherWordmark at plate height (`includeMark`).
 */
const WORD_UNITS = 7;
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
 * On narrow, grows the pane's top padding so the hero sits on its own row
 * above the brand tools (theme / help), never under them.
 */
export function useUnlockHeroLayout(
  paneRef: RefObject<HTMLElement | null>,
  cardRef: RefObject<HTMLElement | null>,
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
      const avail0 = narrow ? cr.width : cardX + cr.width - 40;
      const size = Math.max(28, Math.min(MAX_EM, avail0 / WORD_UNITS));
      const width = size * WORD_UNITS;
      const height = size * 1.25;

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
      const left = cardX + cr.width - width;
      const top = Math.max(8, cardY - gap - height);
      setBox({ left, top, size });
    };

    place();
    const ro = new ResizeObserver(place);
    ro.observe(pane);
    ro.observe(card);
    return () => {
      ro.disconnect();
      pane.style.paddingTop = "";
    };
  }, [paneRef, cardRef]);

  return box;
}
