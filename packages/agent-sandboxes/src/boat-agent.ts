/**
 * The process that runs inside a Boat sandbox: a local agent-browser
 * driver hosted behind the authenticated driver relay.
 *
 * The Boat provider starts it with a detached command (operator
 * configured, typically from a saved snapshot with this package
 * installed) and passes everything it needs through per-sandbox
 * environment variables created with the sandbox — never through the
 * command string, which Boat retains in its command history. Site
 * secrets arrive later, per fill, over the relay itself.
 */

import type { BrowserDriver } from "@opensesame/cua-password-reset";
import { closeOnce } from "./close-once.js";
import { LocalSandboxProvider } from "./local-provider.js";
import { type RunningRelayServer, startRelayServer } from "./relay-server.js";

export const BOAT_AGENT_ENV = {
  /** Relay auth token minted per allocation by the provider. */
  token: "OPENSESAME_RELAY_TOKEN",
  /** Port the relay binds inside the sandbox (loopback only). */
  port: "OPENSESAME_RELAY_PORT",
  /** The ceremony origin this sandbox may navigate to. */
  origin: "OPENSESAME_ORIGIN",
  /** Comma-separated extra allowed hostnames (e.g. an IdP host). */
  extraAllowedDomains: "OPENSESAME_ALLOWED_DOMAINS",
} as const;

export type BoatAgentEnvironment = Readonly<Record<string, string | undefined>>;

export interface BoatAgentCommandOptions {
  agentCommand?: string;
  agentRepoRef?: string;
}

export interface ResolvedBoatAgentCommand {
  command: string;
  /** True when the zero-provision bootstrap will clone and install. */
  bootstrapped: boolean;
}

/** An explicit command wins; blank values count as unconfigured. */
export function resolveBoatAgentCommand(
  options: BoatAgentCommandOptions,
  env: BoatAgentEnvironment = process.env,
): ResolvedBoatAgentCommand {
  const configured = options.agentCommand ?? env.BOAT_RELAY_AGENT_COMMAND;
  if (configured?.trim()) return { command: configured, bootstrapped: false };
  const ref = options.agentRepoRef ?? env.OPENSESAME_BOAT_AGENT_REF;
  return {
    command: defaultBoatAgentCommand(
      ref?.trim() ? ref : BOAT_AGENT_PINNED_COMMIT,
    ),
    bootstrapped: true,
  };
}

/** Public repository the default bootstrap installs the agent from. */
export const BOAT_AGENT_REPO_URL =
  "https://github.com/OpenSesame-Labs/OpenSesame.git";

const COMMIT_SHA = /^[0-9a-f]{40}$/u;

/**
 * The reviewed commit the default bootstrap runs. The in-sandbox agent
 * receives site secrets per fill, so it must never execute whatever a
 * mutable branch or tag points to at allocation time: releases bump
 * this pin to the reviewed commit they ship, and operators may point
 * `OPENSESAME_BOAT_AGENT_REF` at another full commit SHA.
 */
export const BOAT_AGENT_PINNED_COMMIT =
  "a89684800a024fb482d2fd1f98377d6cab9ad95c";

/**
 * The zero-provision start command: fetch one immutable commit from
 * the public repository, verify the checkout is exactly that commit
 * before any install script runs, install only this package's
 * workspace graph from the frozen lockfile, and run the relay agent
 * entry with the lockfile-pinned tsx. Boat sandboxes ship Node and
 * Chrome.
 */
export function defaultBoatAgentCommand(
  ref: string = BOAT_AGENT_PINNED_COMMIT,
): string {
  if (!COMMIT_SHA.test(ref))
    throw new Error(
      "boat agent: repository ref must be a full commit SHA (immutable reviewed commit)",
    );
  return [
    "set -e",
    'cd "$HOME"',
    "if [ ! -d opensesame-agent/.git ]; then git init -q opensesame-agent; fi",
    "cd opensesame-agent",
    `git remote get-url origin >/dev/null 2>&1 || git remote add origin ${BOAT_AGENT_REPO_URL}`,
    `git fetch --depth 1 origin '${ref}'`,
    `git checkout -q --detach '${ref}'`,
    `test "$(git rev-parse HEAD)" = "${ref}"`,
    "corepack enable",
    "corepack pnpm install --frozen-lockfile --filter @opensesame/agent-sandboxes...",
    "cd packages/agent-sandboxes",
    'export AGENT_BROWSER="$HOME/opensesame-agent/packages/cua-password-reset/node_modules/.bin/agent-browser"',
    "exec ./node_modules/.bin/tsx src/boat-agent-main.ts",
  ].join("\n");
}

export interface RunningBoatAgent {
  port: number;
  close(): Promise<void>;
}

function required(env: BoatAgentEnvironment, name: string): string {
  const value = env[name];
  if (!value) throw new Error(`boat agent: missing ${name}`);
  return value;
}

export async function startBoatRelayAgent(
  env: BoatAgentEnvironment,
): Promise<RunningBoatAgent> {
  const token = required(env, BOAT_AGENT_ENV.token);
  const origin = required(env, BOAT_AGENT_ENV.origin);
  const port = Number(env[BOAT_AGENT_ENV.port] ?? "8787");
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error("boat agent: relay port is invalid");
  const extras = (env[BOAT_AGENT_ENV.extraAllowedDomains] ?? "")
    .split(",")
    .map((domain) => domain.trim())
    .filter((domain) => domain.length > 0);
  const sandbox = await new LocalSandboxProvider().allocate({
    origin,
    extraAllowedDomains: extras,
  });
  const close = closeOnce(sandbox.close);
  const driver: BrowserDriver = {
    open: sandbox.browser.open.bind(sandbox.browser),
    snapshot: sandbox.browser.snapshot.bind(sandbox.browser),
    click: sandbox.browser.click.bind(sandbox.browser),
    fill: sandbox.browser.fill.bind(sandbox.browser),
    fillSecret: sandbox.browser.fillSecret.bind(sandbox.browser),
    close,
  };
  const pageUrl = sandbox.browser.pageUrl?.bind(sandbox.browser);
  if (pageUrl) driver.pageUrl = pageUrl;
  let server: RunningRelayServer;
  try {
    server = await startRelayServer({
      host: "127.0.0.1",
      port,
      token,
      driver,
    });
  } catch (error) {
    await close();
    throw error;
  }
  return {
    port: server.port,
    close: async () => {
      await server.close();
      await close();
    },
  };
}
