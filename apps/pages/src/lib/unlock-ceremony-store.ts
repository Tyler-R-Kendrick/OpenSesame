type Listener = () => void;

let active = false;
const listeners = new Set<Listener>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** Holds the unlock gate on screen while lock-v5 doors finish (PR B). */
export const unlockCeremonyStore = {
  getSnapshot(): boolean {
    return active;
  },
  subscribe(listener: Listener): () => void {
    listeners.add(listener);
    return () => listeners.delete(listener);
  },
  begin(): void {
    if (active) return;
    active = true;
    emit();
  },
  end(): void {
    if (!active) return;
    active = false;
    emit();
  },
  /** Test seam */
  reset(): void {
    active = false;
    emit();
  },
};
