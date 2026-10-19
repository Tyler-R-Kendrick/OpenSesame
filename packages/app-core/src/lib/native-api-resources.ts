/** Provider-owned resources share action metadata, execution and bounded result projection. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import { readNativeAgentMailInboxes } from "./native-agentmail.js";
import { NativeApiError } from "./native-api-http.js";
import {
  type NativeApiOperationDefinition,
  executeNativeApiRequest,
} from "./native-api-operations.js";
import { projectNativeStripeIssuingCards } from "./native-api-stripe-issuing.js";
import { projectNativeStripeBalance } from "./native-api-stripe.js";
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
const indices = z.object({
  items: z
    .array(z.object({ name: z.string().min(1).max(4096).refine(printable) }))
    .max(20),
  nbPages: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .optional(),
  message: z.never().optional(),
  status: z.never().optional(),
  error: z.never().optional(),
  errors: z.never().optional(),
});
function projectAlgoliaIndices(body: BoundaryValue): BoundaryValue {
  const response = indices.parse(body);
  if (
    new Set(response.items.map((index) => index.name)).size !==
      response.items.length ||
    (response.nbPages === 0 && response.items.length > 0)
  )
    throw new NativeApiError("response");
  return {
    label: `Showing ${response.items.length} ${response.items.length === 1 ? "index" : "indices"} from first page`,
    items: response.items.map((index) => ({
      id: index.name,
      label: index.name,
    })),
  };
}
const zoneCount = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const zones = z.object({
  success: z.literal(true),
  errors: z.array(z.never()).max(0),
  result: z
    .array(
      z.object({
        id: z.string().min(1).max(32).refine(printable),
        name: z.string().min(1).max(253).refine(printable),
      }),
    )
    .max(20),
  result_info: z
    .object({
      page: z.literal(1).optional(),
      per_page: z.literal(20).optional(),
      count: zoneCount.optional(),
      total_count: zoneCount.optional(),
      total_pages: zoneCount.optional(),
    })
    .optional(),
  error: z.never().optional(),
});
function projectCloudflareZones(body: BoundaryValue): BoundaryValue {
  const response = zones.parse(body);
  const info = response.result_info;
  const count = response.result.length;
  if (
    new Set(response.result.map((zone) => zone.id)).size !== count ||
    (info?.count !== undefined && info.count !== count) ||
    (info?.total_count !== undefined && info.total_count < count) ||
    (info?.total_pages === 0 && count > 0)
  )
    throw new NativeApiError("response");
  return {
    label: `Showing ${count} ${count === 1 ? "zone" : "zones"} from first page`,
    items: response.result.map((zone) => ({ id: zone.id, label: zone.name })),
  };
}
const spaces = z.object({
  sys: z.object({ type: z.literal("Array") }),
  total: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER),
  skip: z.literal(0),
  limit: z.literal(20),
  items: z
    .array(
      z.object({
        sys: z.object({
          type: z.literal("Space"),
          id: z.string().min(1).max(256).refine(printable),
        }),
        name: z.string().min(1).max(4096).refine(printable),
      }),
    )
    .max(20),
  error: z.never().optional(),
  errors: z.never().optional(),
});
function projectContentfulSpaces(body: BoundaryValue): BoundaryValue {
  const response = spaces.parse(body);
  if (
    response.total < response.items.length ||
    new Set(response.items.map((space) => space.sys.id)).size !==
      response.items.length
  )
    throw new NativeApiError("response");
  return {
    label: `Showing ${response.items.length} of ${response.total} spaces from first page`,
    items: response.items.map((space) => ({
      id: space.sys.id,
      label: space.name,
    })),
  };
}
const resources: readonly Resource[] = [
  jsonResource(
    "List Issuing cards",
    {
      providerId: "stripe-issuing",
      operationId: "provider.issuing-cards.read",
      method: "GET",
      path: "/v1/issuing/cards",
      query: { limit: 20 },
      headers: { "Stripe-Version": "2026-09-30.endive" },
    },
    projectNativeStripeIssuingCards,
  ),
  jsonResource(
    "Read account balance",
    {
      providerId: "stripe",
      operationId: "provider.balance.read",
      method: "GET",
      path: "/v1/balance",
      headers: { "Stripe-Version": "2026-09-30.endive" },
    },
    projectNativeStripeBalance,
  ),
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
  jsonResource(
    "List spaces",
    {
      providerId: "contentful",
      operationId: "provider.spaces.read",
      method: "GET",
      path: "/spaces",
      query: { limit: 20, skip: 0 },
    },
    projectContentfulSpaces,
  ),
  jsonResource(
    "List zones",
    {
      providerId: "cloudflare",
      operationId: "provider.zones.read",
      method: "GET",
      path: "/client/v4/zones",
      query: { page: 1, per_page: 20 },
    },
    projectCloudflareZones,
  ),
  jsonResource(
    "List indices",
    {
      providerId: "algolia",
      operationId: "provider.indices.read",
      method: "GET",
      path: "/1/indexes",
      query: { page: 0, hitsPerPage: 20 },
    },
    projectAlgoliaIndices,
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
