import type { Capability, CapabilityExclusion } from "./types.js";

/**
 * The browser extension as the local runner of a sandboxed run (ADR 0076 §8,
 * ADR 0079 §4, ADR 0082 §4): it claims the steps of a run its person owns,
 * executes each verb in the page it is armed for, performs the custody steps
 * in its own sealed store, and settles outcomes in the shape the Host decodes.
 * The step routes themselves are the Host's (`agent.runs.*`); these rows are
 * the extension's own messages, from its own pages, that put the runner on
 * and off and say what is ready.
 */
const ADR_AGENT_HOOKS = "0159-agent-hooks-interceptor.md";

/**
 * Arming is the person's consent to let software act inside one signed-in
 * third-party session. An agent that could arm a site would grant itself the
 * page it is about to drive.
 */
const A_PERSON_ARMS: CapabilityExclusion = {
  reason:
    "arming a site is a person's consent to let the runner act inside their signed-in session; an agent that could arm one would grant itself the page it is about to drive",
  adr: ADR_AGENT_HOOKS,
};

const RUNNER_STATE_IS_THE_PERSONS: CapabilityExclusion = {
  reason:
    "the runner's readiness names which sites a person holds credentials for and has armed; that is the person's own, and an agent has no use for it but to probe",
  adr: ADR_AGENT_HOOKS,
};

const ONLY_THE_EXTENSION_DRIVES_A_BROWSER: CapabilityExclusion = {
  reason:
    "the local runner is the browser extension's role: it is the one surface that holds the page, the browser's per-origin grant and the sealed credentials a step resolves",
  adr: ADR_AGENT_HOOKS,
};

function runnerRow(
  id: string,
  title: string,
  kind: Capability["kind"],
  message: string,
  agents: CapabilityExclusion,
): Capability {
  return {
    id,
    title,
    plane: "client_local",
    kind,
    surfaces: {
      cli: null,
      pwa: null,
      mcp_host: null,
      mcp_client: null,
      webmcp: null,
      extension: `message:${message}`,
      android: null,
    },
    excluded: {
      cli: ONLY_THE_EXTENSION_DRIVES_A_BROWSER,
      pwa: ONLY_THE_EXTENSION_DRIVES_A_BROWSER,
      mcp_host: agents,
      mcp_client: agents,
      webmcp: agents,
      android: ONLY_THE_EXTENSION_DRIVES_A_BROWSER,
    },
  };
}

export const extensionRunnerCapabilities: readonly Capability[] = [
  runnerRow(
    "agent.runs.drive.arm",
    "Arm one origin for this browser's local runner, for a bounded time, once the browser has granted it",
    "ceremony",
    "opensesame.runner.arm",
    A_PERSON_ARMS,
  ),
  runnerRow(
    "agent.runs.drive.disarm",
    "Stop the local runner at an origin and give the browser's grant back",
    "act",
    "opensesame.runner.disarm",
    A_PERSON_ARMS,
  ),
  runnerRow(
    "agent.runs.drive.status",
    "Say what the local runner has ready: a Host session, a private window, a recovery key, credentials held, origins armed",
    "read",
    "opensesame.runner.status",
    RUNNER_STATE_IS_THE_PERSONS,
  ),
];
