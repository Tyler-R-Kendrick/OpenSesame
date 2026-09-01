/**
 * The only thing that leaves the device, written out one field at a time.
 *
 * Every value here is rebuilt from an already-sanitized request rather than
 * spread from it. That is the difference between an allow-list and a hope: a
 * spread forwards whatever it is handed, so a key nobody anticipated rides
 * along; a rebuild has nowhere to put one. `sanitizeSupportRequest` has
 * already refused anything structurally wrong upstream — this pass is what
 * makes the wire format itself enumerable, so the egress test can assert the
 * serialized body equals an expected structure with no extra keys.
 *
 * The body is deliberately OpenSesame's own envelope rather than an AG-UI
 * `RunAgentInput`. `RunAgentInput` carries `state`, `tools` and
 * `forwardedProps` — three open containers we would have to prove empty on
 * every call — and it would push the page vocabulary into an opaque
 * `context[].value` string where a structural scan can no longer see it. The
 * AG-UI half of this integration is the response: the endpoint answers with an
 * AG-UI event stream, which is what `@ag-ui/client` decodes.
 */

import type {
  SupportMessageRole,
  SupportRequest,
  SupportTargetRole,
} from "@opensesame/support-agent";

export type AgUiOutboundMessage = {
  readonly role: SupportMessageRole;
  readonly text: string;
};

export type AgUiOutboundTarget = {
  readonly id: string;
  readonly description: string;
  readonly role: SupportTargetRole;
  readonly mounted: boolean;
};

export type AgUiOutboundRoute = {
  readonly id: string;
  readonly title: string;
};

export type AgUiOutboundState = {
  readonly id: string;
  readonly value: boolean;
};

export type AgUiOutboundCapability = {
  readonly id: string;
  readonly title: string;
  readonly available: boolean;
};

export type AgUiOutboundGoal = {
  readonly id: string;
  readonly title: string;
};

export type AgUiOutboundHelp = {
  readonly id: string;
  readonly title: string;
  readonly answer: string;
  readonly goal: string | null;
};

export type AgUiOutboundTool = {
  readonly name: string;
  readonly description: string;
  readonly exposed: boolean;
};

export type AgUiOutboundContext = {
  readonly version: 1;
  readonly pageId: string;
  readonly route: string;
  readonly targets: readonly AgUiOutboundTarget[];
  readonly routes: readonly AgUiOutboundRoute[];
  readonly state: readonly AgUiOutboundState[];
  readonly capabilities: readonly AgUiOutboundCapability[];
  readonly goals: readonly AgUiOutboundGoal[];
  readonly help: readonly AgUiOutboundHelp[];
  readonly tools: readonly AgUiOutboundTool[];
};

export type AgUiOutboundBody = {
  readonly version: 1;
  readonly instructions: string;
  readonly context: AgUiOutboundContext;
  readonly history: readonly AgUiOutboundMessage[];
  readonly question: string;
};

export function buildAgUiOutboundBody(
  request: SupportRequest,
  instructions: string,
): AgUiOutboundBody {
  const context = request.context;
  return {
    version: 1,
    instructions,
    context: {
      version: 1,
      pageId: context.pageId,
      route: context.route,
      targets: context.targets.map((target) => ({
        id: target.id,
        description: target.description,
        role: target.role,
        mounted: target.mounted,
      })),
      routes: context.routes.map((route) => ({
        id: route.id,
        title: route.title,
      })),
      state: context.state.map((fact) => ({
        id: fact.id,
        value: fact.value,
      })),
      capabilities: context.capabilities.map((capability) => ({
        id: capability.id,
        title: capability.title,
        available: capability.available,
      })),
      goals: context.goals.map((goal) => ({
        id: goal.id,
        title: goal.title,
      })),
      help: context.help.map((entry) => ({
        id: entry.id,
        title: entry.title,
        answer: entry.answer,
        goal: entry.goal,
      })),
      tools: context.tools.map((tool) => ({
        name: tool.name,
        description: tool.description,
        exposed: tool.exposed,
      })),
    },
    history: request.history.map((message) => ({
      role: message.role,
      text: message.text,
    })),
    question: request.question,
  };
}
