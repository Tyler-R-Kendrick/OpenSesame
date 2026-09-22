/**
 * The former `App` body lives in `app-root.tsx` (ownership.md §3, S05). This
 * re-export keeps the historical import path for tests and tooling.
 */
export { AppRoot as App, type AppSlots } from "./app-root.js";
