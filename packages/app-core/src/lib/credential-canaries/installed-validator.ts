/** Detection-only adapter with explicitly installed storage, no ambient vault authority. */
import { z } from "zod";
import {
  type ControlledMcpRequest,
  controlledMcpResponse,
  validateControlledMcpRequest,
} from "./mcp-protocol.js";
import { controlledIdentifierDigest } from "./protocol.js";
import { type CanaryEvent, MAX_CANARY_EVENTS, eventSchema } from "./records.js";
import {
  type ControlledValidatorBinding,
  validatorBindingSchema,
} from "./validator-binding.js";
const stateSchema = z
  .object({
    v: z.literal(1),
    binding: validatorBindingSchema,
    events: z.array(eventSchema).max(MAX_CANARY_EVENTS),
  })
  .strict();
export interface ControlledValidatorStoragePort {
  /** Must serialize across processes and refresh private installed storage. */
  transaction<T>(
    work: (
      raw: string | null,
      save: (value: string) => Promise<void>,
    ) => Promise<T>,
  ): Promise<T>;
}
export function initializeControlledValidatorState(
  binding: ControlledValidatorBinding,
): string {
  const parsed = validatorBindingSchema.parse(binding);
  if (parsed.context.kind !== "mcp_configuration")
    throw new Error("A controlled MCP binding is required.");
  return JSON.stringify({ v: 1, binding: parsed, events: [] });
}
function readState(raw: string | null, binding: ControlledValidatorBinding) {
  if (!raw || new TextEncoder().encode(raw).length > 32768)
    throw new Error("Installed validator unavailable.");
  const state = stateSchema.parse(JSON.parse(raw));
  if (
    state.binding.context.kind !== "mcp_configuration" ||
    new Set(state.events.map((e) => e.eventId)).size !== state.events.length ||
    JSON.stringify(state.binding) !==
      JSON.stringify(validatorBindingSchema.parse(binding)) ||
    state.events.some(
      (e) =>
        e.vaultIdentity !== binding.context.vaultIdentity ||
        e.artifactId !== binding.artifactId ||
        e.kind !== binding.context.kind ||
        e.generation !== binding.context.generation,
    )
  )
    throw new Error("Installed validator context changed.");
  return state;
}
export async function handleInstalledControlledMcpRequest(
  input: {
    binding: ControlledValidatorBinding;
    storage: ControlledValidatorStoragePort;
    presentedId: string;
  },
  request: ControlledMcpRequest,
) {
  const message = validateControlledMcpRequest(request);
  return input.storage.transaction(async (raw, save) => {
    const state = readState(raw, input.binding);
    if (
      (await controlledIdentifierDigest(
        state.binding.context,
        input.presentedId,
      )) !== state.binding.digestB64
    )
      throw new Error("Unknown controlled validator identifier.");
    const now = Date.now();
    const phase = message.method === "tools/call" ? "invoked" : "connected";
    const recent = state.events.filter((e) => now - Date.parse(e.at) < 3600000);
    if (
      state.events.length < MAX_CANARY_EVENTS &&
      recent.length < 8 &&
      !recent.some((e) => e.phase === phase && now - Date.parse(e.at) < 60000)
    ) {
      const event: CanaryEvent = {
        v: 1,
        eventId: crypto.randomUUID(),
        vaultIdentity: state.binding.context.vaultIdentity,
        artifactId: state.binding.artifactId,
        kind: state.binding.context.kind,
        generation: state.binding.context.generation,
        phase,
        at: new Date(now).toISOString(),
      };
      state.events.push(event);
      await save(JSON.stringify(state));
    }
    return controlledMcpResponse(message);
  });
}
export function listInstalledControlledValidatorEvents(
  binding: ControlledValidatorBinding,
  storage: ControlledValidatorStoragePort,
): Promise<CanaryEvent[]> {
  return storage.transaction(async (raw) => readState(raw, binding).events);
}
