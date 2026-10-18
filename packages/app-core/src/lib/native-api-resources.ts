/** Provider-owned resources share action metadata, execution and bounded result projection. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import { readNativeAgentMailInboxes } from "./native-agentmail.js";
import { NativeApiError } from "./native-api-http.js";
import {
  type NativeApiOperationDefinition,
  executeNativeApiRequest,
} from "./native-api-operations.js";
import type { NativeApiReadResult } from "./native-api-verify.js";
import type { NativeMethod } from "./native-connector-schema.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { zodJitless } from "./zod-jitless.js";

zodJitless();
type ResourceReader = (
  id: string,
  input: Record<string, string>,
  transport: NativeProviderTransport,
) => Promise<NativeApiReadResult>;
type Resource = {
  providerId: string;
  id: string;
  label: string;
  read: ResourceReader;
};
const resultSchema = z.object({
  label: z.string(),
  items: z.array(z.object({ id: z.string(), label: z.string() })).max(100),
});
function jsonResource(
  label: string,
  definition: NativeApiOperationDefinition,
  project: (body: BoundaryValue) => BoundaryValue,
): Resource {
  return {
    providerId: definition.providerId,
    id: definition.operationId,
    label,
    async read(id, input, transport) {
      transport.assertCurrent();
      if (Object.keys(input).length)
        throw new Error(`${label} does not accept request fields`);
      return resultSchema.parse(
        await executeNativeApiRequest(id, definition, {}, project, transport),
      );
    },
  };
}
function printable(value: string): boolean {
  return [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  });
}
const outbound = z.object({
  TotalCount: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  Messages: z
    .array(
      z.object({
        MessageID: z
          .string()
          .regex(
            /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
          ),
        Subject: z.string().max(4096).refine(printable),
        Status: z.enum(["Sent", "Processed", "Queued"]),
        MessageStream: z.literal("outbound"),
      }),
    )
    .max(20),
  ErrorCode: z.never().optional(),
  Message: z.never().optional(),
  error: z.never().optional(),
  errors: z.never().optional(),
});
function projectPostmarkMessages(body: BoundaryValue): BoundaryValue {
  const response = outbound.parse(body);
  if (
    response.Messages.length > response.TotalCount ||
    new Set(response.Messages.map((message) => message.MessageID.toLowerCase()))
      .size !== response.Messages.length
  )
    throw new NativeApiError("response");
  return {
    label: `Showing ${response.Messages.length} of ${response.TotalCount} messages in outbound stream`,
    items: response.Messages.map((message) => ({
      id: message.MessageID,
      label: `${message.Subject || "(No subject)"} — ${message.Status}`,
    })),
  };
}
const resources: readonly Resource[] = [
  {
    providerId: "agentmail",
    id: "provider.inboxes.read",
    label: "List inboxes",
    read: readNativeAgentMailInboxes,
  },
  jsonResource(
    "List outbound messages",
    {
      providerId: "postmark",
      operationId: "provider.messages.read",
      method: "GET",
      path: "/messages/outbound",
      query: { count: 20, offset: 0, messagestream: "outbound" },
    },
    projectPostmarkMessages,
  ),
];
/** Both UI and runtime derive their closed operations from this one provider-owned registry. */
export function nativeApiResourceActions(
  providerId: string,
  method: NativeMethod,
) {
  if (method !== "api-key") return [];
  return resources
    .filter((resource) => resource.providerId === providerId)
    .map(({ id, label }) => ({ id, label }));
}
export function invokeNativeApiResource(
  providerId: string,
  id: string,
  operation: string,
  input: Record<string, string>,
  transport: NativeProviderTransport,
): Promise<NativeApiReadResult> | null {
  transport.assertCurrent();
  const resource = resources.find(
    (entry) => entry.providerId === providerId && entry.id === operation,
  );
  return resource ? resource.read(id, input, transport) : null;
}
