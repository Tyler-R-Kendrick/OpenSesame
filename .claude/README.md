# .claude

`hooks/session-start.sh` runs on Claude Code `SessionStart` and, when it
proceeds, runs `pnpm install` and generates the drizzle database schema
(`db:generate`) so the workspace is ready to use immediately.

It only does anything when explicitly opted in
(`OPENSESAME_AGENT_BOOTSTRAP=1`) or when the environment shows real evidence
of an ephemeral remote Claude Code session (`CLAUDE_CODE_REMOTE` /
`CLAUDECODE` set). In any other shell it is a silent no-op.

**Why so cautious:** a repo-controlled `SessionStart` hook executes before a
human has necessarily reviewed the checkout, so by default it must be inert.
It also refuses outright — even when opted in — if `OPENSESAME_ENV=production`
or production-shaped secrets (`OPENSESAME_CLAIM_PEPPER`,
`OPENSESAME_AUTH_SECRET`) are present in the environment. It never runs
database migrations automatically.
