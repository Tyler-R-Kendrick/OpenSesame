/**
 * The field's hint. A phone's field is 178px wide at 320, so the desktop line
 * is cut mid-word there; its touch twin is the same three verbs, short enough
 * to be read whole (`verify:mobile` measures it at every width).
 */
export function commandPlaceholder(asks: boolean, touch: boolean): string {
  if (touch) return asks ? "Command or ask…" : "go · search · copy";
  return asks
    ? "Command or ask… copy password for github"
    : "go to vault · search · copy password for …";
}
