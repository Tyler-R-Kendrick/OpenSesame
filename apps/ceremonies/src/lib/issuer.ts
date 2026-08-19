/** Identity API origin every ceremony page talks to. */
export const issuer =
  import.meta.env.VITE_OPENSESAME_ISSUER ?? "http://127.0.0.1:8788";

/** Console origin, offered when a ceremony is better finished signed in. */
export const consoleOrigin =
  import.meta.env.VITE_OPENSESAME_CONSOLE ?? "http://127.0.0.1:5173";
