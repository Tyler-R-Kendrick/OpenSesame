/**
 * Deterministic safe display for merchant / destination labels (WAL-B06).
 * Never treat labels as HTML/Markdown. Strip bidi controls and angle-bracket
 * markup so critical amount/destination digits cannot be visually overridden.
 */

function stripControlsAndBidi(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const code = ch.codePointAt(0) ?? 0;
    const isC0C1 =
      code <= 0x1f || code === 0x7f || (code >= 0x80 && code <= 0x9f);
    const isBidi =
      code === 0x61c ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x206f);
    if (isC0C1 || isBidi) continue;
    out += ch;
  }
  return out;
}

const ANGLE_MARKUP = /[<>`]/gu;

export function safeMerchantLabel(raw: string, maxLen = 120): string {
  const stripped = stripControlsAndBidi(raw).replace(ANGLE_MARKUP, "");
  const collapsed = stripped.replace(/\s+/gu, " ").trim();
  if (collapsed.length === 0) return "(unnamed merchant)";
  const points = Array.from(collapsed);
  if (points.length <= maxLen) return collapsed;
  return `${points.slice(0, Math.max(1, maxLen - 1)).join("")}…`;
}
