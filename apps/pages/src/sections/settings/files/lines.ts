/** The length of the longest line of `text`, found without splitting it: a
 * spread of a hundred thousand line lengths into `Math.max` throws. */
export function longestLine(text: string): number {
  let longest = 0;
  let from = 0;
  while (from <= text.length) {
    const next = text.indexOf("\n", from);
    const end = next < 0 ? text.length : next;
    if (end - from > longest) longest = end - from;
    if (next < 0) break;
    from = next + 1;
  }
  return longest;
}
