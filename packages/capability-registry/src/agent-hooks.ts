import { extensionRunnerCapabilities } from "./extension-runner.js";
import type { Capability, CapabilityExclusion } from "./index.js";
import { webLoginRecipeCapabilities } from "./web-login-recipes.js";

export const ADR_AGENT_HOOKS = "0159-agent-hooks-interceptor.md";

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

/**
 * The audit of the verdicts an organization's Host has answered. It is the
 * trail of the agent's own decisions: an agent that could read it could probe
 * the policy that governs it one verdict at a time.
 */
const AUDIT_OF_THE_AGENTS_VERDICTS: CapabilityExclusion = {
  reason:
    "the audit of an agent's own verdicts; an agent that could read it could probe the policy that governs it one decision at a time",
  adr: ADR_AGENT_HOOKS,
};

const DECISIONS_EXCLUSIONS = {
  ...POLICY_EXCLUSIONS,
  mcp_host: AUDIT_OF_THE_AGENTS_VERDICTS,
  mcp_client: AUDIT_OF_THE_AGENTS_VERDICTS,
  webmcp: AUDIT_OF_THE_AGENTS_VERDICTS,
} as const;

/**
 * A preset is a posture an operator chooses for the agent. An agent that
 * could list them would learn which postures it may be put under, and one
 * that could apply one would govern itself; applying one is an ordinary
 * replacement of the policy and takes its step-up.
 */
const PRESETS_ARE_THE_OPERATORS_CHOICE: CapabilityExclusion = {
  reason:
    "a preset is a posture an operator chooses for the agent; an agent that could list or apply one would learn what governs it, or govern itself",
  adr: ADR_AGENT_HOOKS,
};

const PRESETS_ARE_THE_OPERATORS_CHOICE_EXCLUSIONS = {
  ...POLICY_EXCLUSIONS,
  mcp_host: PRESETS_ARE_THE_OPERATORS_CHOICE,
  mcp_client: PRESETS_ARE_THE_OPERATORS_CHOICE,
  webmcp: PRESETS_ARE_THE_OPERATORS_CHOICE,
} as const;

/**
 * Who an escalated action is put to. An agent that could read it would know
 * whom to lobby or impersonate; one that could write it would choose its own
 * approver.
 */
const APPROVER_GOVERNS_THE_AGENT: CapabilityExclusion = {
  reason:
    "who the Host asks to lift an escalation is configuration that governs the agent; an agent that could read it would learn whom to target, and one that could write it would choose its own approver",
  adr: ADR_AGENT_HOOKS,
};

const HOST_APPROVER_FROM_THE_CLI: CapabilityExclusion = {
  reason:
    "the Host's hook approver is administered from the native CLI; this surface runs no agent loop and never names a Host",
  adr: ADR_AGENT_HOOKS,
};

const APPROVER_EXCLUSIONS = {
  pwa: HOST_APPROVER_FROM_THE_CLI,
  mcp_host: APPROVER_GOVERNS_THE_AGENT,
  mcp_client: APPROVER_GOVERNS_THE_AGENT,
  webmcp: APPROVER_GOVERNS_THE_AGENT,
  extension: HOST_APPROVER_FROM_THE_CLI,
  android: HOST_APPROVER_FROM_THE_CLI,
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
 * A Host-run agent's hook records are the audit of what governed it: which of
 * its actions were refused, escalated or rewritten. An agent that could read
 * them would learn what to route around.
 */
const RUN_RECORDS_ARE_THE_AGENTS_AUDIT: CapabilityExclusion = {
  reason:
    "a hosted run's hook records are the audit of what governed the agent; an agent that could read them would learn which of its actions were refused and what to route around",
  adr: ADR_AGENT_HOOKS,
};

/**
 * Read from the native CLI beside `rotate runs` and `rotate watch`. Pages
 * reads a run's sealed log with the viewer key it holds, and never names a
 * Host; the extension and Android run no agent loop.
 */
const RUN_RECORDS_FROM_THE_CLI: CapabilityExclusion = {
  reason:
    "a hosted run's hook records are read from the native CLI; this surface names no Host and runs no agent loop, and a run's sealed log is read by the client that holds its viewer key",
  adr: ADR_AGENT_HOOKS,
};

const RUN_RECORDS_EXCLUSIONS = {
  pwa: RUN_RECORDS_FROM_THE_CLI,
  mcp_host: RUN_RECORDS_ARE_THE_AGENTS_AUDIT,
  mcp_client: RUN_RECORDS_ARE_THE_AGENTS_AUDIT,
  webmcp: RUN_RECORDS_ARE_THE_AGENTS_AUDIT,
  extension: RUN_RECORDS_FROM_THE_CLI,
  android: RUN_RECORDS_FROM_THE_CLI,
} as const;

/**
 * OpenSesame as an agent-hooks/0.1 interceptor (ADR 0159): the verdict for
 * one interception — locally, or from the Host — and the policy that
 * decides it.
 */
export const agentHooksCapabilities: readonly Capability[] = [
  {
    id: "agent_hooks.intercept",
    title:
      "Answer an agent-hooks interception with a verdict: tool rules and the secret guard, and — with an approver configured — an escalation put to a person",
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
      "Replace the organization's agent-hooks policy on the Host (compare-and-set; from a file or a named preset; needs the operator token or a fresh passkey step-up)",
    plane: "host",
    kind: "admin",
    surfaces: { cli: "opensesame hooks policy put", ...CLI_ONLY },
    excluded: POLICY_EXCLUSIONS,
  },
  {
    id: "agent_hooks.approver.read",
    title:
      "Read who the Host puts the organization's escalated agent actions to (an inbox handle, its version, and whether the Host has an Identity API to ask through)",
    plane: "host",
    kind: "read",
    surfaces: { cli: "opensesame hooks approver get", ...CLI_ONLY },
    excluded: APPROVER_EXCLUSIONS,
  },
  {
    id: "agent_hooks.approver.write",
    title:
      "Set or clear who the Host puts the organization's escalated agent actions to (compare-and-set; needs the operator token or a fresh passkey step-up)",
    plane: "host",
    kind: "admin",
    surfaces: { cli: "opensesame hooks approver put", ...CLI_ONLY },
    excluded: APPROVER_EXCLUSIONS,
  },
  {
    id: "agent_hooks.policy.presets.read",
    title:
      "List and show the named agent-hooks policy presets (rotation-web-login, strict, observe), compiled in so no Host is needed",
    plane: "host",
    kind: "read",
    surfaces: { cli: "opensesame hooks policy preset ls", ...CLI_ONLY },
    excluded: PRESETS_ARE_THE_OPERATORS_CHOICE_EXCLUSIONS,
  },
  {
    id: "agent_hooks.policy.presets.remote",
    title:
      "List the named agent-hooks policy presets over the Host API (GET /api/v1/agent-hooks/presets), with the digest a stored policy's audit carries",
    plane: "host",
    kind: "read",
    surfaces: { cli: null, ...CLI_ONLY },
    excluded: {
      ...PRESETS_ARE_THE_OPERATORS_CHOICE_EXCLUSIONS,
      cli: {
        reason:
          "the CLI lists and shows the same presets from the table compiled into the binary (`opensesame hooks policy preset ls|show`), which needs no Host",
        adr: ADR_AGENT_HOOKS,
      },
    },
  },
  {
    id: "agent_hooks.decisions.read",
    title:
      "Read the audit of the agent-hooks verdicts the Host answered (value-blind, paginated, filterable)",
    plane: "host",
    kind: "read",
    surfaces: { cli: "opensesame hooks decisions", ...CLI_ONLY },
    excluded: DECISIONS_EXCLUSIONS,
  },
  {
    id: "agent_hooks.run_records.read",
    title:
      "Read a Host-run agent's payload-free hook records and their verdict summary (ADR 0081 §9: the observation of a run that has no viewer key)",
    plane: "host",
    kind: "read",
    surfaces: { cli: "opensesame access connectors rotate hooks", ...CLI_ONLY },
    excluded: RUN_RECORDS_EXCLUSIONS,
  },
  // The recipes those hosted runs replay, and their signers (ADR 0076 §4).
  ...webLoginRecipeCapabilities,
  // The browser extension as the local runner of those runs (ADR 0079 §4).
  ...extensionRunnerCapabilities,
];
