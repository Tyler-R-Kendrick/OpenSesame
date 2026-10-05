/**
 * Which tutorial teaches each key (ADR 0163 §6). A key is a thing a person
 * does, so it needs a tutorial like any control. Every entry names the goal
 * that teaches it and the words that goal says it in: `coverage.test.ts`
 * fails when the goal does not exist or does not say them.
 *
 * Many keys share a tutorial on purpose (the movement keys are one lesson).
 */
export type KeymapTutorial = Readonly<{ goal: string; says: string }>;

export const KEYMAP_TUTORIALS: Readonly<Record<string, KeymapTutorial>> = {
  "section.vault": { goal: "shell.sections", says: "Press g then v" },
  "section.settings": { goal: "shell.sections", says: "opened with g then s" },
};
