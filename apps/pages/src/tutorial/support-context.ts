import { createContext } from "react";
import type { SupportController } from "./session.js";

/**
 * The support controller's context, on its own so a hook outside `session.ts`
 * can read it without importing the composition root at runtime — the type
 * import above is erased, and a module cycle through the shell is what left
 * this undefined at render once.
 */
export const SupportContext = createContext<SupportController | null>(null);
