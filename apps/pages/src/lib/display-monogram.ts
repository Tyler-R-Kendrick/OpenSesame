/** First letter of a display name for identity rows; no connector branding deps. */
export function monogram(displayName: string): string {
  const letter = displayName.trim().charAt(0);
  return letter ? letter.toLocaleUpperCase() : "?";
}
