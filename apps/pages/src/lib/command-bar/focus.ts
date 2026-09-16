/** Focus and chrome chords for the shell omnibox. */

let micToggle: (() => void) | null = null;

/** Focus the shell omnibox. Keymap `:` and Ctrl/Cmd+L land here. */
export function focusCommandBar(): void {
  const input = document.getElementById("command-bar-input");
  if (input instanceof HTMLInputElement) {
    input.focus();
    input.select();
  }
}

/** CommandBar registers its listen toggle so the keymap can fire `m`. */
export function registerCommandBarMic(toggle: () => void): () => void {
  micToggle = toggle;
  return () => {
    if (micToggle === toggle) micToggle = null;
  };
}

export function toggleCommandBarMic(): void {
  micToggle?.();
}

/**
 * Browser-chrome chords that must win over the typing() gate and the
 * metaKey bailout — like focusing the URL bar from anywhere in the page.
 */
export function handleCommandBarChord(event: KeyboardEvent): boolean {
  if (event.altKey || event.shiftKey || event.isComposing) return false;
  if (!(event.metaKey || event.ctrlKey)) return false;
  if (event.key.toLowerCase() !== "l") return false;
  event.preventDefault();
  focusCommandBar();
  return true;
}
