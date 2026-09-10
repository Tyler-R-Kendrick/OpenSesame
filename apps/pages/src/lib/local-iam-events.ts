const events = new EventTarget();

/** No identity, credential or vault data is carried in these invalidations. */
export function notifyLocalIamChange(): void {
  events.dispatchEvent(new Event("change"));
}

export function subscribeLocalIamChanges(listener: () => void): () => void {
  events.addEventListener("change", listener);
  return () => events.removeEventListener("change", listener);
}
