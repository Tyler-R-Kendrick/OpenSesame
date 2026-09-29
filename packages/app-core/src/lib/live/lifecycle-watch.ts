/**
 * Bind the document's own pagehide and pageshow to the live session.
 *
 * Binding is deferred until a session starts (ADR 0130: a module does nothing
 * at import). A host with no document listener — the Node test host — is skipped.
 */

import {
  type BoundaryValue,
  isBoolean,
  overlapCast,
} from "@opensesame/os-domain";
import { maybePage } from "../../ports.js";

let bound = false;

/** Handler evidence. The bfcache gate is a real history navigation, not this. */
export function readPageShowPersisted(event: Event): boolean {
  if (!("persisted" in event)) return false;
  const flag = overlapCast<Event, { persisted: BoundaryValue }>(
    event,
  ).persisted;
  return isBoolean(flag) && flag === true;
}

/**
 * `onLeave` runs for a real document navigation (pagehide), which closes
 * peer connections before the browser considers the back/forward cache.
 * `onRestore` receives that navigation's persisted flag.
 */
export function watchDocumentLifecycle(
  onLeave: () => void,
  onRestore: (persisted: boolean) => void,
): void {
  if (bound) return;
  const current = maybePage();
  if (current === undefined) return;
  const onHide = () => {
    onLeave();
  };
  const onShow = (event: Event) => {
    onRestore(readPageShowPersisted(event));
  };
  try {
    current.addEventListener("pagehide", onHide);
    current.addEventListener("pageshow", onShow);
  } catch {
    // Node's test host exposes a page port with no document listener.
    return;
  }
  bound = true;
}
