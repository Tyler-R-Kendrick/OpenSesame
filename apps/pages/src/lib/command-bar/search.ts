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
  /**
   * Take the keyboard when the words are committed. True only if focus really
   * landed on the listing: an empty list has nothing to land on, and the
   * caret then stays in the field rather than being dropped on the page.
   */
  focus?: () => boolean;
};

const consumers = new Set<SearchConsumer>();

export function registerSearchConsumer(consumer: SearchConsumer): () => void {
  consumers.add(consumer);
  return () => {
    consumers.delete(consumer);
  };
}

/**
 * Hand the keyboard to the listing that is searching. `took`: focus moved
 * to it. `seen`: a listing is on screen but had nothing to take focus, so the
 * field keeps it. `none`: nothing on screen is searching, which is the
 * caller's cue to bring one up.
 */
export function commitToConsumer(): "took" | "seen" | "none" {
  let seen = false;
  for (const consumer of consumers) {
    if (!consumer.visible()) continue;
    if (consumer.focus?.() === true) return "took";
    seen = true;
  }
  return seen ? "seen" : "none";
}
