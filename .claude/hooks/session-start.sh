#!/usr/bin/env bash
# SessionStart hook: bootstraps dependencies + drizzle schema generation, but
# only when explicitly opted in or clearly running in an ephemeral remote
# Claude Code container, and never when production-shaped credentials are
# present. See .claude/README.md for the full rationale.
set -euo pipefail

# This sandbox's inherited NODE_OPTIONS can be poisoned (e.g. a malformed
# "--import tsx" flag combo) which makes plain node/pnpm/corepack invocations
# fail outright. Unset it defensively so a broken inherited env var can never
# silently break this hook.
unset NODE_OPTIONS

# --- Trust gate #1: opt-in or remote-session detection -----------------
# Default OFF for a plain local shell. Only proceed if the user explicitly
# opted in, or there is real evidence this is a Claude Code (remote) session.
if [ "${OPENSESAME_AGENT_BOOTSTRAP:-}" != "1" ] \
   && [ -z "${CLAUDE_CODE_REMOTE:-}" ] \
   && [ -z "${CLAUDECODE:-}" ]; then
  echo "[session-start] bootstrap skipped (not opted in)" >&2
  exit 0
fi

# --- Trust gate #2: production-credential refusal -----------------------
# A repo-controlled hook runs before a human has necessarily reviewed the
# checkout. Even if gate #1 passed, refuse outright if the environment looks
# like it holds production credentials.
if [ "${OPENSESAME_ENV:-}" = "production" ] \
   || [ -n "${OPENSESAME_CLAIM_PEPPER:-}" ] \
   || [ -n "${OPENSESAME_AUTH_SECRET:-}" ]; then
  echo "[session-start] refusing automated bootstrap: production-shaped credentials are present in this environment" >&2
  exit 0
fi

# --- Both gates passed: bootstrap the workspace -------------------------
echo "[session-start] enabling corepack..."
NODE_OPTIONS= corepack enable

echo "[session-start] installing dependencies..."
NODE_OPTIONS= pnpm install --frozen-lockfile

echo "[session-start] generating drizzle schema..."
# Dev-only defaults are safe here because gate #2 already ruled out
# production-shaped credentials in the environment.
NODE_OPTIONS= OPENSESAME_ALLOW_DEV_DEFAULTS=true OPENSESAME_ENV=development \
  pnpm --filter @opensesame/database db:generate

# Intentionally NOT running any migration command here: migrations need a
# live Postgres instance, which is not guaranteed to be available in this
# bootstrap context, and running one automatically against an unknown
# database would be unsafe.

echo "[session-start] bootstrap complete"
