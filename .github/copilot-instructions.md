Follow the root `AGENTS.md`. That file is the canonical agent context.

When asked to run the app locally, attach a live HMR debug session and watch
it: start `pnpm --filter @opensesame/pages dev:web` (or `dev` for the full
stack), open `http://localhost:5180`, subscribe to console / page / network
errors, and patch the hot-reloaded process. Do not hand off a URL or switch
to a production `dist/` unless a merge gate was requested.

See `skills/local-debug-session/SKILL.md`.
