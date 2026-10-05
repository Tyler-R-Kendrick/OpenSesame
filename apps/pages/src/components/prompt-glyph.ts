/**
 * Whether a prompt segment is drawing its glyph *in place of* its name.
 *
 * `glyph.css` decides — the rail draws the glyph beside the name, the phone's
 * top bar draws the glyph alone — so the behaviour that belongs to a glyph
 * standing for a name (a held finger asks for the switcher) asks the browser
 * what is actually drawn. A segment still showing its name keeps everything it
 * always had: on a tablet the rail's prompt answers a long-press with the
 * session menu, as before, glyph or no glyph beside it.
 */
export function glyphStandsForName(segment: Element): boolean {
  const name = segment.querySelector(".prompt__name");
  return name !== null && getComputedStyle(name).display === "none";
}
