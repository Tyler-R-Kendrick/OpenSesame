/**
 * Whether menus take the phone arrangement (DESIGN.md § Touch): a coarse
 * pointer or a narrow screen. Read when a menu opens, as the page reads it.
 */
export function asSheet(): boolean {
  return (
    window.matchMedia?.("(pointer: coarse), (max-width: 900px)").matches ??
    false
  );
}
