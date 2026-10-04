/**
 * Whether a prompt segment is drawing its glyph rather than its name.
 *
 * `glyph.css` decides — the phone's top bar draws the glyph, the rail draws
 * the name — so the behaviour that belongs to the glyph (a held finger asks
 * for the switcher) asks the browser what is actually drawn, and a segment
 * still showing its name keeps everything it always had: on a tablet the
 * rail's prompt answers a long-press with the session menu, as before.
 */
export function glyphIsDrawn(segment: Element): boolean {
  const glyph = segment.querySelector(".prompt__glyph");
  return glyph !== null && getComputedStyle(glyph).display !== "none";
}
