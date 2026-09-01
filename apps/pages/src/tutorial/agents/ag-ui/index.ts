/**
 * The optional AG-UI support transport.
 *
 * Everything exported here is an OpenSesame type. `@ag-ui/client`'s own types
 * — `BaseEvent`, `RunAgentInput`, `HttpAgent`, rxjs `Observable` — stop at
 * `transport.ts`, so importing this barrel neither names them nor loads them.
 */

export {
  type AgUiEndpoint,
  type AgUiEndpointConfig,
  AG_UI_CONFIG_KEY,
  agUiEndpointSeams,
  applyAgUiEndpoint,
  currentAgUiEndpoint,
  loadAgUiEndpoint,
  readAgUiEndpoint,
  readAgUiEndpointUrl,
  resetAgUiEndpointForTest,
} from "./endpoint.js";
export {
  type AgUiOutboundBody,
  type AgUiOutboundCapability,
  type AgUiOutboundContext,
  type AgUiOutboundGoal,
  type AgUiOutboundMessage,
  type AgUiOutboundRoute,
  type AgUiOutboundState,
  type AgUiOutboundTarget,
  buildAgUiOutboundBody,
} from "./outbound.js";
export {
  type AgUiClient,
  type AgUiClientLoader,
  type AgUiEventObserver,
  type AgUiEventSource,
  type AgUiEventSubscription,
  type AgUiFetch,
  type AgUiHttpOpen,
  type AgUiTransport,
  type AgUiTransportOptions,
  type AgUiTransportRequest,
  createAgUiTransport,
} from "./transport.js";
export {
  type AgUiSupportAgentOptions,
  createAgUiAgent,
  createAgUiSupportAgent,
} from "./ag-ui-agent.js";
