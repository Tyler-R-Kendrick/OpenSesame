/**
 * Where the keyboard lands.
 *
 * The workspace is keyboard-first (DESIGN.md, "VFS interaction model"), and
 * that holds only if every arrival leaves the keyboard somewhere useful. A
 * page load, an unlock, a route change, a browser back, a switched tab — each
 * leaves `document.activeElement` on `<body>` unless something claims it, and
 * from `<body>` the first Tab starts at the top of the document, the vault
 * cursor has no visible home, and a phone shows no keyboard at all.
 *
 * Every screen owns its landing: the unlock form's secret field, the first
 * road of setup, the first vault on the front door, the tree in the vault, the
 * content of a section. These helpers are the one vocabulary they share.
 */

const CONTROL =
  'button:not([disabled]), a[href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])';

/** True when nothing real holds the keyboard: `<body>`, nothing, or an element that has left the document. */
export function keyboardIsIdle(): boolean {
  const active = document.activeElement;
  return active === null || active === document.body || !active.isConnected;
}

/**
 * Put the keyboard on `element`. Says whether it landed — a disabled control,
 * a hidden pane or a detached node refuses focus, and the caller may then try
 * the next home.
 */
export function landFocus(element: Element | null | undefined): boolean {
  if (!(element instanceof HTMLElement) || !element.isConnected) return false;
  element.focus({ preventScroll: true });
  return document.activeElement === element;
}

/** The first thing a person could press inside `root`, in document order. */
export function firstControl(
  root: ParentNode | null | undefined,
): HTMLElement | null {
  const found = root?.querySelector(CONTROL);
  return found instanceof HTMLElement ? found : null;
}
