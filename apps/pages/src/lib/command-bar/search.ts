import { useSyncExternalStore } from "react";

/**
 * Search lives in the shell's one text field.
 *
 * While the status-line prompt holds `/? words` (or `/search words`) the words
 * are published here, and whichever listing is on screen narrows to them as
 * they are typed. No listing draws a field of its own, so there is never a
 * second box to type into and the words stay where the person typed them.
 */

let words: string | null = null;
const watchers = new Set<() => void>();

/** What the prompt is searching for; `null` when it holds anything else. */
export function liveSearch(): string | null {
  return words;
}

/** Set by the prompt only. */
export function publishSearch(next: string | null): void {
  if (next === words) return;
  words = next;
  for (const watch of watchers) watch();
}

export function useLiveSearch(): string | null {
  return useSyncExternalStore(
    (onChange) => {
      watchers.add(onChange);
      return () => watchers.delete(onChange);
    },
    liveSearch,
    () => null,
  );
}

/** A listing that narrows to the prompt's words while it is mounted. */
export type SearchConsumer = {
  /** On screen now? A phone mounts a pane it is not showing. */
  visible: () => boolean;
  /** Where the keyboard goes when the words are committed. */
  focus?: () => void;
};

const consumers = new Set<SearchConsumer>();

export function registerSearchConsumer(consumer: SearchConsumer): () => void {
  consumers.add(consumer);
  return () => {
    consumers.delete(consumer);
  };
}

/**
 * Hand the keyboard to the listing that is searching. False when none is on
 * screen, which is the caller's cue to bring one up.
 */
export function commitToConsumer(): boolean {
  for (const consumer of consumers) {
    if (!consumer.visible()) continue;
    consumer.focus?.();
    return true;
  }
  return false;
}
