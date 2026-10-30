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
    command: defaultBoatAgentCommand(ref?.trim() ? ref : "main"),
    bootstrapped: true,
  };
}

/** Public repository the default bootstrap installs the agent from. */
export const BOAT_AGENT_REPO_URL =
  "https://github.com/Tyler-R-Kendrick/OpenSesame.git";

const SAFE_REF = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/u;

/**
 * The zero-provision start command: clone the public repository into
 * the sandbox, install only this package's workspace graph, and run
 * the relay agent entry. Boat sandboxes ship Node and Chrome; the
 * pinned tsx runner executes the TypeScript entry directly.
 */
export function defaultBoatAgentCommand(ref = "main"): string {
  if (!SAFE_REF.test(ref) || ref.includes(".."))
    throw new Error("boat agent: invalid repository ref");
  return [
    "set -e",
    'cd "$HOME"',
    `if [ ! -d opensesame-agent ]; then git clone --depth 1 --branch '${ref}' ${BOAT_AGENT_REPO_URL} opensesame-agent; fi`,
    "cd opensesame-agent",
    "corepack enable",
    "corepack pnpm install --filter @opensesame/agent-sandboxes...",
    "cd packages/agent-sandboxes",
    'export AGENT_BROWSER="$HOME/opensesame-agent/packages/cua-password-reset/node_modules/.bin/agent-browser"',
    "exec corepack pnpm dlx tsx@4.20.3 src/boat-agent-main.ts",
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
  let browserClose: Promise<void> | undefined;
  const closeBrowser = async () => {
    browserClose ??= sandbox.close();
    try {
      await browserClose;
    } catch (error) {
      browserClose = undefined;
      throw error;
    }
  };
  const driver: BrowserDriver = {
    open: (url) => sandbox.browser.open(url),
    snapshot: () => sandbox.browser.snapshot(),
    click: (ref) => sandbox.browser.click(ref),
    fill: (ref, value) => sandbox.browser.fill(ref, value),
    fillSecret: (ref, value) => sandbox.browser.fillSecret(ref, value),
    close: closeBrowser,
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
    await closeBrowser();
    throw error;
  }
  return {
    port: server.port,
    close: async () => {
      await server.close();
      await closeBrowser();
    },
  };
}
