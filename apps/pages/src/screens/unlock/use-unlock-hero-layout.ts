import { type RefObject, useLayoutEffect, useState } from "react";

/** Prototype lock-v5 hero: max em, gap above the card (wide / narrow). */
const MAX_EM = 90;
const GAP_WIDE = 34;
const GAP_NARROW = 20;
const NARROW_BP = 1100;
/**
 * Width of `0PEN SESAME` + mark in em — same shape as lock-v5.html
 * (`asc*1.25 + gapEm + NL*adv` ≈ 7 for Share Tech Mono metrics).
 */
const WORD_UNITS = 7;

export type UnlockHeroBox = {
  left: number;
  top: number;
  size: number;
};

/**
 * Place the unlock CipherWordmark as a hero above the card — the same fit as
 * lock-v5.html (`maxEm: 90`, wide right-aligned to the card, gap 34/20).
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
      const cr = card.getBoundingClientRect();
      const narrow = pr.width < NARROW_BP;
      const cardX = cr.left - pr.left;
      const cardY = cr.top - pr.top;
      const avail = narrow ? cr.width : cardX + cr.width - 40;
      const size = Math.max(28, Math.min(MAX_EM, avail / WORD_UNITS));
      const gap = narrow ? GAP_NARROW : GAP_WIDE;
      // Mark square ≈ 1.25em plate; letters ≈ NL * 0.6em + gap (lock-v5).
      const width = size * WORD_UNITS;
      const height = size * 1.25;
      const left = narrow ? cardX : cardX + cr.width - width;
      const top = Math.max(8, cardY - gap - height);
      setBox({ left, top, size });
    };

    place();
    const ro = new ResizeObserver(place);
    ro.observe(pane);
    ro.observe(card);
    return () => ro.disconnect();
  }, [paneRef, cardRef]);

  return box;
}
