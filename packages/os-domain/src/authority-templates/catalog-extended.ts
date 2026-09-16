/**
 * Additional audience templates shipped as data-only defaults.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export const EXTENDED_AUDIENCE_TEMPLATE_SOURCE = [
  {
    id: "guest",
    version: "1.0.0",
    label: "Guest stay",
    summary:
      "Temporary stay domain with check-in/out windows and selected resource grants only.",
    vocabulary: {
      domain: "Stay",
      participant: "Guest",
      supervisor: "Host",
    },
    defaults: {
      lifetimeKind: "temporary",
      inheritance: "isolated",
      defaultLifetimeMs: 3 * DAY_MS,
      maxLifetimeMs: 14 * DAY_MS,
      suggestedVerbs: ["check-in", "grant", "revoke", "check-out"],
    },
    limits: {
      maxDelegationDepth: 1,
      endOfEngagementTerminates: true,
      forbidSecretReadFromSupervision: true,
    },
    supportMatrix: [
      {
        id: "physical.lock",
        label: "Physical lock",
        status: "unsupported",
        note: "No tested adapter; real lock integration is not claimed.",
      },
      {
        id: "os.app_blocking",
        label: "OS app blocking",
        status: "unsupported",
        note: "Unsupported on this template.",
      },
    ],
    workflowHints: [
      "check-in/check-out",
      "selected Wi-Fi or lock-like resources",
      "no inherited property-wide access",
    ],
  },
  {
    id: "classroom",
    version: "1.0.0",
    label: "Classroom / lab",
    summary:
      "Class domain with instructor/participant vocabulary, lab caps, and isolation outside the class.",
    vocabulary: {
      domain: "Class",
      participant: "Student",
      supervisor: "Instructor",
    },
    defaults: {
      lifetimeKind: "temporary",
      inheritance: "isolated",
      defaultLifetimeMs: DAY_MS,
      maxLifetimeMs: 7 * DAY_MS,
      suggestedVerbs: ["attend", "request", "approve", "cap", "end"],
    },
    limits: {
      maxDelegationDepth: 2,
      forbidSecretReadFromSupervision: true,
      observerOnlyAllowed: true,
    },
    supportMatrix: [
      {
        id: "os.app_blocking",
        label: "OS app blocking",
        status: "unsupported",
        note: "Attendance must not imply device lockdown.",
      },
      {
        id: "dns.blocky",
        label: "DNS (Blocky)",
        status: "configuration_required",
        note: "Optional lab network filter only when configured.",
      },
    ],
    workflowHints: [
      "attendance/request without secret access",
      "scheduled lab eligibility",
      "resource caps",
      "individual isolation",
    ],
  },
  {
    id: "incident",
    version: "1.0.0",
    label: "Incident response",
    summary:
      "Tight incident subdomain with emergency exceptions, auditor separation, and evidence-preserving termination.",
    vocabulary: {
      domain: "Incident",
      participant: "Responder",
      supervisor: "Incident lead",
    },
    defaults: {
      lifetimeKind: "temporary",
      inheritance: "isolated",
      defaultLifetimeMs: 12 * 60 * 60 * 1000,
      maxLifetimeMs: 3 * DAY_MS,
      suggestedVerbs: ["activate", "exception", "observe", "export", "close"],
    },
    limits: {
      maxDelegationDepth: 2,
      requireIndependentApprover: true,
      endOfEngagementTerminates: true,
    },
    supportMatrix: [
      {
        id: "dns.blocky",
        label: "DNS (Blocky)",
        status: "unsupported",
        note: "Incident scope is grant/domain narrowing, not DNS product claims.",
      },
      {
        id: "os.app_blocking",
        label: "OS app blocking",
        status: "unsupported",
        note: "Unsupported.",
      },
    ],
    workflowHints: [
      "reviewed emergency exception",
      "observer/auditor separation",
      "terminate without deleting evidence",
      "separately controlled exports",
    ],
  },
  {
    id: "ci",
    version: "1.0.0",
    label: "CI / deployment job",
    summary:
      "Job-bound authority for service actors with exact environment binding and parent-failure invalidation.",
    vocabulary: {
      domain: "Job",
      participant: "Workload",
      supervisor: "Pipeline",
    },
    defaults: {
      lifetimeKind: "temporary",
      inheritance: "isolated",
      defaultLifetimeMs: 2 * 60 * 60 * 1000,
      maxLifetimeMs: 12 * 60 * 60 * 1000,
      suggestedVerbs: ["mint", "bind", "invoke", "invalidate"],
    },
    limits: {
      maxDelegationDepth: 2,
      endOfEngagementTerminates: true,
    },
    supportMatrix: [
      {
        id: "os.app_blocking",
        label: "OS app blocking",
        status: "unsupported",
        note: "Irrelevant to CI job authority.",
      },
      {
        id: "dns.blocky",
        label: "DNS (Blocky)",
        status: "unsupported",
        note: "Not claimed for CI templates.",
      },
    ],
    workflowHints: [
      "job-bound credentials",
      "exact artifact/environment binding",
      "retry-safe side effects",
      "parent failure invalidation",
    ],
  },
  {
    id: "agent-workcell",
    version: "1.0.0",
    label: "Autonomous workcell",
    summary:
      "Task domain for orchestrator and spawned workloads with conserved aggregate budgets and denied ambient egress.",
    vocabulary: {
      domain: "Workcell",
      participant: "Worker",
      supervisor: "Orchestrator",
    },
    defaults: {
      lifetimeKind: "temporary",
      inheritance: "isolated",
      defaultLifetimeMs: 4 * 60 * 60 * 1000,
      maxLifetimeMs: DAY_MS,
      suggestedVerbs: ["spawn", "delegate", "bound", "revoke"],
      usageAccounting: "wall_clock_union",
    },
    limits: {
      maxDelegationDepth: 4,
      endOfEngagementTerminates: true,
      forbidSecretReadFromSupervision: true,
    },
    supportMatrix: [
      {
        id: "sandbox.wasmtime",
        label: "Wasmtime sandbox",
        status: "configuration_required",
        note: "Profile crate exists; portal does not claim every spawn is sandboxed until wired.",
      },
      {
        id: "os.app_blocking",
        label: "OS app blocking",
        status: "unsupported",
        note: "Workers are not OS app blocks.",
      },
    ],
    workflowHints: [
      "unique workload identity",
      "correlated resource bounds",
      "conserved aggregate budgets",
      "parent revocation",
    ],
  },
  {
    id: "research-workshop",
    version: "1.0.0",
    label: "Research workshop",
    summary:
      "Novel custom audience proving extensibility: a temporary workshop domain with observer notes and capped shared tools.",
    vocabulary: {
      domain: "Workshop",
      participant: "Researcher",
      supervisor: "Facilitator",
    },
    defaults: {
      lifetimeKind: "temporary",
      inheritance: "inherit",
      defaultLifetimeMs: 2 * DAY_MS,
      maxLifetimeMs: 7 * DAY_MS,
      suggestedVerbs: ["join", "share-tool", "observe", "close"],
    },
    limits: {
      maxDelegationDepth: 2,
      observerOnlyAllowed: true,
      endOfEngagementTerminates: true,
    },
    supportMatrix: [
      {
        id: "dns.blocky",
        label: "DNS (Blocky)",
        status: "unsupported",
        note: "Workshop templates stay data-only.",
      },
      {
        id: "os.app_blocking",
        label: "OS app blocking",
        status: "unsupported",
        note: "Unsupported.",
      },
    ],
    workflowHints: [
      "shared tool caps",
      "observer notes",
      "close ends workshop grants",
    ],
  },
];
