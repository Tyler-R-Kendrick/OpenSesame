import { liveSearchOf } from "@opensesame/app-core/lib/command-bar/parse.js";
import { registerCommandBarFill } from "./focus.js";
import { publishSearch } from "./search.js";

/** The stand-in prompt a test types into, and how it puts the prompt away. */
export type StandInPrompt = {
  type: (value: string) => void;
  stop: () => void;
};

/**
 * Stands in for the status-line prompt where a test renders a listing without
 * the shell: typing into the prompt is `type("/? words")`, Esc or a Clear key
 * writes `""` back, and the listing sees what it would see in the app.
 */
export function standInPrompt(): StandInPrompt {
  const write = (value: string) => publishSearch(liveSearchOf(value));
  const unregister = registerCommandBarFill(write);
  return {
    type: write,
    stop: () => {
      unregister();
      publishSearch(null);
    },
  };
}
