/** Light ink on a dark surface — dial alphas were tuned for dark ink on white. */
function isLightInk(rgb: [number, number, number]): boolean {
  return (rgb[0] + rgb[1] + rgb[2]) / 3 > 140;
}

/**
 * Ink with alpha. On dark theme (light `--ink`) lift alpha so rings keep the
 * same subtle-but-visible presence as in light stills (lock-v5).
 */
export function inkAlpha(rgb: [number, number, number], a: number): string {
  const scaled = isLightInk(rgb) ? Math.min(1, a * 1.55) : a;
  return `rgba(${rgb[0]},${rgb[1]},${rgb[2]},${scaled})`;
}

export function readInkRgb(root: HTMLElement): [number, number, number] {
  const style = getComputedStyle(root);
  const raw = style.getPropertyValue("--ink").trim();
  if (!raw) return [15, 15, 15];
  if (raw.startsWith("#")) {
    const hex = raw.slice(1);
    const full =
      hex.length === 3
        ? hex
            .split("")
            .map((c) => c + c)
            .join("")
        : hex;
    const n = Number.parseInt(full, 16);
    return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }
  const parts = raw.split(/\s+/).map(Number);
  if (parts.length >= 3) return [parts[0], parts[1], parts[2]];
  return [15, 15, 15];
}
