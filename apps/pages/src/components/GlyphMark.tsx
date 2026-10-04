import {
  GLYPH_COLS,
  GLYPH_ROWS,
  type GlyphKind,
  glyphOf,
} from "@opensesame/app-core/lib/glyph.js";
import { type CSSProperties, useMemo } from "react";
import "./glyph.css";

/**
 * Dot pitch, and the extra gap between braille cells, in viewBox units. The
 * grid is the same one the terminal writes as braille (`lib/glyph.ts`): a cell
 * is 2 dots wide and 4 high, so the extra gap every second column and every
 * fourth row is what makes the mark read as braille rather than as a grid.
 */
const PITCH = 3;
const CELL_GAP = 2;
const ON = 1.1;
const OFF = 0.5;
const WIDTH = GLYPH_COLS * PITCH + (GLYPH_COLS / 2 - 1) * CELL_GAP;
const HEIGHT = GLYPH_ROWS * PITCH + (GLYPH_ROWS / 4 - 1) * CELL_GAP;

function centre(index: number, cell: number): number {
  return index * PITCH + Math.floor(index / cell) * CELL_GAP + PITCH / 2;
}

function circle(x: number, y: number, r: number): string {
  return `M${x - r} ${y}a${r} ${r} 0 1 0 ${2 * r} 0a${r} ${r} 0 1 0 ${-2 * r} 0`;
}

type Props = {
  kind: GlyphKind;
  /** The id the device shows in the clear — never a sealed name. */
  id: string;
  className?: string;
};

/**
 * The dotted mark for a vault, a person or an organization: the glyph a phone
 * draws where a name will not fit. Decorative — whatever it stands for names
 * itself on the control that wears it (`aria-label`), so a screen reader never
 * meets the dots.
 */
export function GlyphMark({ kind, id, className }: Props) {
  const glyph = useMemo(() => glyphOf(kind, id), [kind, id]);
  const paths = useMemo(() => {
    let on = "";
    let off = "";
    for (const [row, dots] of glyph.dots.entries()) {
      for (const [col, lit] of dots.entries()) {
        const x = centre(col, 2);
        const y = centre(row, 4);
        if (lit) on += circle(x, y, ON);
        else off += circle(x, y, OFF);
      }
    }
    return { on, off };
  }, [glyph]);
  const style: CSSProperties & { "--glyph-hue": number } = {
    "--glyph-hue": glyph.hue,
  };
  return (
    <svg
      className={className ? `glyph ${className}` : "glyph"}
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      aria-hidden="true"
      focusable="false"
      style={style}
    >
      <path className="glyph__off" d={paths.off} />
      <path className="glyph__on" d={paths.on} />
    </svg>
  );
}
