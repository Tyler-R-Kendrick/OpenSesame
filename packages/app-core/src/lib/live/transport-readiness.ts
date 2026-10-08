/** Shared readiness only: queued profile work never grants live or vault authority. */
let pending = 0;
let revision = 0;
const listeners = new Set<() => void>();

export function transportReadiness() {
  return { pending, revision };
}

export function onTransportReadinessChange(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function changed(): void {
  revision += 1;
  for (const listener of listeners) listener();
}

/** Called at the gesture, before optimistic drawing or queued asynchronous work. */
export function beginTransportEdit(): () => void {
  pending += 1;
  changed();
  let finished = false;
  return () => {
    if (finished) return;
    finished = true;
    pending -= 1;
    changed();
  };
}
