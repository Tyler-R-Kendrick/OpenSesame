/**
 * How a timestamp reads on the Access screen.
 *
 * Shared because the receipts trail moved into its own module and both halves
 * still date the same kinds of row the same way.
 */

export function formatTime(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}
