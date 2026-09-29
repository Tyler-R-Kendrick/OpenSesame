import type { Capability, CapabilityExclusion } from "./index.js";

export const ADR_AGENT_HOOKS = "0150-agent-hooks-interceptor.md";

/**
 * An interceptor answers the framework that runs an agent loop, at that
 * loop's own seams (agent-hooks/0.1 §7). A tool the governed agent could
 * call would let it probe the policy that governs it, or pre-clear an action
 * before the host asks; the agent is the subject of the verdict, never its
 * caller.
 */
const INTERCEPTOR_ANSWERS_THE_HOST: CapabilityExclusion = {
  reason:
    "an interceptor answers the agent framework at its own loop's seams; a tool the governed agent could call would let it probe or pre-clear the policy that governs it",
  adr: ADR_AGENT_HOOKS,
};

/**
 * The Pages PWA, the browser extension and the Android app run no agent loop
 * of their own, so there is no host there for an interceptor to answer.
 */
const NO_AGENT_LOOP_HERE: CapabilityExclusion = {
  reason:
    "this surface runs no agent loop; agent-hooks verdicts are answered to the framework that does, through the native CLI",
  adr: ADR_AGENT_HOOKS,
};

const EXCLUDED_BESIDE_THE_CLI = {
  pwa: NO_AGENT_LOOP_HERE,
  mcp_host: INTERCEPTOR_ANSWERS_THE_HOST,
  mcp_client: INTERCEPTOR_ANSWERS_THE_HOST,
  webmcp: INTERCEPTOR_ANSWERS_THE_HOST,
  extension: NO_AGENT_LOOP_HERE,
  android: NO_AGENT_LOOP_HERE,
} as const;

/**
 * The policy an organization's Host decides agent-hooks verdicts under. An
 * agent that could read it would learn exactly which of its actions a person
 * must lift; one that could write it would govern itself.
 */
const POLICY_GOVERNS_THE_AGENT: CapabilityExclusion = {
  reason:
    "the Host's hook policy governs the agent; an agent that could read it would learn what to route around, and one that could write it would govern itself",
  adr: ADR_AGENT_HOOKS,
};

/**
 * Host administration from the native CLI. Pages is complete without a
 * backend and never names a Host; the extension and Android run no agent
 * loop for the policy to govern.
 */
const HOST_POLICY_FROM_THE_CLI: CapabilityExclusion = {
  reason:
    "the Host's hook policy is administered from the native CLI; this surface runs no agent loop and never names a Host",
  adr: ADR_AGENT_HOOKS,
};

const POLICY_EXCLUSIONS = {
  pwa: HOST_POLICY_FROM_THE_CLI,
  mcp_host: POLICY_GOVERNS_THE_AGENT,
  mcp_client: POLICY_GOVERNS_THE_AGENT,
  webmcp: POLICY_GOVERNS_THE_AGENT,
  extension: HOST_POLICY_FROM_THE_CLI,
  android: HOST_POLICY_FROM_THE_CLI,
} as const;

const CLI_ONLY = {
  pwa: null,
  mcp_host: null,
  mcp_client: null,
  webmcp: null,
  extension: null,
  android: null,
} as const;

/**
 * OpenSesame as an agent-hooks/0.1 interceptor (ADR 0150): the verdict for
 * one interception — locally, or from the Host — and the policy that
 * decides it.
 */
export const agentHooksCapabilities: readonly Capability[] = [
  {
    id: "agent_hooks.intercept",
    title:
      "Answer an agent-hooks interception with a verdict: tool rules and the secret guard",
    plane: "host",
    kind: "act",
    surfaces: { cli: "opensesame hooks intercept", ...CLI_ONLY },
    excluded: EXCLUDED_BESIDE_THE_CLI,
  },
  {
    id: "agent_hooks.policy.check",
    title: "Check an agent-hooks policy and show it with its defaults",
    plane: "host",
    kind: "read",
    surfaces: { cli: "opensesame hooks check", ...CLI_ONLY },
    excluded: EXCLUDED_BESIDE_THE_CLI,
  },
  {
    id: "agent_hooks.intercept.remote",
    title:
      "Answer an agent-hooks interception over the Host API, under the organization's stored policy",
    plane: "host",
    kind: "act",
    surfaces: { cli: null, ...CLI_ONLY },
    excluded: {
      ...EXCLUDED_BESIDE_THE_CLI,
      cli: {
        reason:
          "the agent framework calls POST /api/v1/agent-hooks/intercept itself; at a terminal the same verdict is `opensesame hooks intercept`, which needs no Host",
        adr: ADR_AGENT_HOOKS,
      },
    },
  },
  {
    id: "agent_hooks.policy.read",
    title: "Read the organization's agent-hooks policy on the Host",
    plane: "host",
    kind: "read",
    surfaces: { cli: "opensesame hooks policy get", ...CLI_ONLY },
    excluded: POLICY_EXCLUSIONS,
  },
  {
    id: "agent_hooks.policy.write",
    title:
      "Replace the organization's agent-hooks policy on the Host (compare-and-set)",
    plane: "host",
    kind: "admin",
    surfaces: { cli: "opensesame hooks policy put", ...CLI_ONLY },
    excluded: POLICY_EXCLUSIONS,
  },
];
