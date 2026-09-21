const events = new EventTarget();

import { emitActivity } from "./activity-log.js";

/** No identity, credential or vault data is carried in these invalidations. */
export function notifyLocalIamChange(): void {
  events.dispatchEvent(new Event("change"));
  emitActivity({
    category: "identity",
    type: "identity.changed",
    summary: "Identity or access state changed",
    outcome: "info",
  });
}

export function subscribeLocalIamChanges(listener: () => void): () => void {
  events.addEventListener("change", listener);
  return () => events.removeEventListener("change", listener);
}
