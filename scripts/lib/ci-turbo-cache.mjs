import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Remote-cache environment for one CI run.
 * Fork pull requests and runs without TURBO_TOKEN are read-only.
 * The token is returned to the caller and never written to the log here.
 *
 * @param {object} [githubContext]
 * @param {string} [githubContext.eventName]
 * @param {string} [githubContext.event_name]
 * @param {string} [githubContext.repository]
 * @param {string} [githubContext.headRepository]
 * @param {string} [githubContext.token]
 * @param {string} [githubContext.team]
 * @param {{ TURBO_TOKEN?: string }} [githubContext.secrets]
 * @param {{ TURBO_TEAM?: string }} [githubContext.vars]
 * @returns {{ TURBO_TOKEN: string, TURBO_REMOTE_CACHE_READ_ONLY: "true" | "false", TURBO_TEAM: string }}
 */
export function turboCacheEnv(githubContext = {}) {
  const eventName = text(githubContext.eventName ?? githubContext.event_name);
  const repository = text(
    githubContext.repository ??
      githubContext.payload?.repository?.full_name ??
      githubContext.event?.repository?.full_name,
  );
  const headRepository = text(
    githubContext.headRepository ??
      githubContext.payload?.pull_request?.head?.repo?.full_name ??
      githubContext.event?.pull_request?.head?.repo?.full_name,
  );
  const token = text(githubContext.token ?? githubContext.secrets?.TURBO_TOKEN);
  const team = text(githubContext.team ?? githubContext.vars?.TURBO_TEAM);
  const forkPullRequest =
    eventName === "pull_request" &&
    (headRepository.length === 0 || headRepository !== repository);
  const readOnly = forkPullRequest || token.length === 0;
  return {
    TURBO_TOKEN: token,
    TURBO_REMOTE_CACHE_READ_ONLY: readOnly ? "true" : "false",
    TURBO_TEAM: team,
  };
}

function text(value) {
  return typeof value === "string" ? value.trim() : "";
}

function writeCacheEnv(env) {
  const values = turboCacheEnv({
    eventName: env.GITHUB_EVENT_NAME,
    repository: env.GITHUB_REPOSITORY,
    headRepository: env.HEAD_REPOSITORY,
    token: env.TURBO_TOKEN,
    team: env.TURBO_TEAM,
  });
  for (const [key, value] of Object.entries(values)) {
    if (/[\r\n]/.test(value)) {
      throw new Error(`${key} must be a single line`);
    }
  }
  const body = `${Object.entries(values)
    .map(([key, value]) => `${key}=${value}`)
    .join("\n")}\n`;
  if (env.GITHUB_ENV) {
    appendFileSync(env.GITHUB_ENV, body);
    return;
  }
  process.stdout.write(
    `TURBO_REMOTE_CACHE_READ_ONLY=${values.TURBO_REMOTE_CACHE_READ_ONLY}\nTURBO_TEAM=${values.TURBO_TEAM.length > 0 ? "set" : ""}\nTURBO_TOKEN=${values.TURBO_TOKEN.length > 0 ? "set" : ""}\n`,
  );
}

const invoked =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invoked) writeCacheEnv(process.env);
