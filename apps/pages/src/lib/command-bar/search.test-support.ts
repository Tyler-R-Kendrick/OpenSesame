import { liveSearchOf } from "@opensesame/app-core/lib/command-bar/parse.js";
import { registerCommandBarFill } from "./focus.js";
import { publishSearch } from "./search.js";

/**
 * Stands in for the status-line prompt where a test renders a listing without
 * the shell: typing into the prompt is `type("/? words")`, Esc or a Clear key
 * writes `""` back, and the listing sees what it would see in the app.
 */
export function standInPrompt(): {
  type: (value: string) => void;
  stop: () => void;
} {
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
