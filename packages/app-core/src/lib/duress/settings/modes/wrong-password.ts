import type { DuressMode } from "./mode.js";

/**
 * The refusal a wrong password gets. The id stays `refuse`, the name callers
 * already pass; what it seals is `locked`.
 */
export const WRONG_PASSWORD = {
  id: "refuse",
  label: "Wrong password",
  opens: "nothing; it reads as a wrong password",
  consent: "I understand this code is refused like a wrong password.",
  presentation: "locked",
  input: { kind: "none" },
} as const satisfies DuressMode;
