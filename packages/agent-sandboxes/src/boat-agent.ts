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
  let server: RunningRelayServer;
  try {
    server = await startRelayServer({
      host: "127.0.0.1",
      port,
      token,
      driver: sandbox.browser,
    });
  } catch (error) {
    await sandbox.close();
    throw error;
  }
  return {
    port: server.port,
    close: async () => {
      await server.close();
      await sandbox.close();
    },
  };
}
