/**
 * In-progress edits on this page.
 *
 * A service-worker release change reloads the document. That reload is held
 * while any edit is unsaved, and a forced reload (lock, idle, a chunk that
 * no longer exists) asks each registered saver to persist what it can first.
 * A saver that cannot finish is skipped: the reload still happens.
 */

export type DraftSaver = () =>
  | Promise<boolean | undefined>
  | boolean
  | undefined;

type Hold = { id: string };

const holds = new Map<string, Hold>();
const savers = new Map<string, DraftSaver>();
const listeners = new Set<() => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

/** The page has something the person has not saved. */
export function anyDirtyEdit(): boolean {
  return holds.size > 0;
}

/** A saver is registered, whether or not its editor is dirty right now. */
export function hasDraftSaver(): boolean {
  return savers.size > 0;
}

/**
 * Mark `id` unsaved. The returned function clears it. Calling it twice, or
 * holding the same id again, is safe: the latest hold wins.
 */
export function holdDirtyEdit(id: string): () => void {
  const hold: Hold = { id };
  holds.set(id, hold);
  emit();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (holds.get(id) === hold) {
      holds.delete(id);
      emit();
    }
  };
}

/** Replace the saver for `id`. Absent means this editor cannot persist quietly. */
export function registerDraftSaver(id: string, save: DraftSaver): () => void {
  savers.set(id, save);
  return () => {
    if (savers.get(id) === save) savers.delete(id);
  };
}

export function subscribeDirtyEdit(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Ask every saver to persist. One failure does not skip the others, and does
 * not throw: the caller is about to reload either way.
 */
export async function saveDirtyDrafts(): Promise<void> {
  const jobs = [...savers.values()];
  await Promise.all(
    jobs.map(async (save) => {
      try {
        await save();
      } catch {
        // Not feasible. The reload that asked still proceeds.
      }
    }),
  );
}

/** Test seam: forget every hold and saver. */
export function resetDirtyEdits(): void {
  holds.clear();
  savers.clear();
  emit();
}
