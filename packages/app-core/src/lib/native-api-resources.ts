/** Provider-owned resources share action metadata, execution and bounded result projection. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import { readNativeAgentMailInboxes } from "./native-agentmail.js";
import { projectNativeAgentcardOrganization } from "./native-api-agentcard.js";
import { nativeCatalogResources } from "./native-api-catalog-resources.js";
import { nativeCiCloudResources } from "./native-api-ci-cloud-resources.js";
import { nativeDataWorkspaceResources } from "./native-api-data-workspace-resources.js";
import { NativeApiError } from "./native-api-http.js";
import { projectNativeLithicCards } from "./native-api-lithic.js";
import { projectNativeMarqetaUsers } from "./native-api-marqeta.js";
import { nativeMessagingInventories } from "./native-api-messaging-inventories.js";
import { nativePrimaryCollections } from "./native-api-primary-collections.js";
import { projectNativePrivacyCards } from "./native-api-privacy.js";
import { projectNativeRazorpayPayments } from "./native-api-razorpay.js";
import { type Resource, jsonResource } from "./native-api-resource.js";
import { nativeServiceInventories } from "./native-api-service-inventories.js";
import { projectNativeStripeIssuingCards } from "./native-api-stripe-issuing.js";
import { projectNativeStripeBalance } from "./native-api-stripe.js";
import type { NativeApiReadResult } from "./native-api-verify.js";
import type { NativeMethod } from "./native-connector-schema.js";
import type { NativeProviderTransport } from "./native-connector-transport.js";
import { zodJitless } from "./zod-jitless.js";

zodJitless();
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
const monitors = z
  .array(
    z.object({
      id: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
      name: z.string().min(1).max(4096).refine(printable),
    }),
  )
  .max(20);
function projectDatadogMonitors(body: BoundaryValue): BoundaryValue {
  const response = monitors.parse(body);
  if (new Set(response.map((monitor) => monitor.id)).size !== response.length)
    throw new NativeApiError("response");
  return {
    label: `Showing ${response.length} ${response.length === 1 ? "monitor" : "monitors"} from first page`,
    items: response.map((monitor) => ({
      id: String(monitor.id),
      label: monitor.name,
    })),
  };
}
const resources: readonly Resource[] = [
  ...nativeMessagingInventories,
  ...nativeServiceInventories,
  jsonResource(
    "Read platform organization",
    {
      providerId: "agentcard",
      operationId: "provider.organization.read",
      method: "GET",
      path: "/api/v2",
    },
    projectNativeAgentcardOrganization,
  ),
  jsonResource(
    "List users",
    {
      providerId: "marqeta",
      operationId: "provider.users.read",
      method: "GET",
      path: "/v3/users",
      query: { count: 10, start_index: 0, fields: "token,active" },
    },
    projectNativeMarqetaUsers,
  ),
  ...nativeCiCloudResources,
  ...nativePrimaryCollections,
  ...nativeCatalogResources,
  ...nativeDataWorkspaceResources,
  jsonResource(
    "List cards",
    {
      providerId: "privacy",
      operationId: "provider.cards.read",
      method: "GET",
      path: "/v1/cards",
      query: { page: 1, page_size: 20 },
    },
    projectNativePrivacyCards,
  ),
  jsonResource(
    "List cards",
    {
      providerId: "lithic",
      operationId: "provider.cards.read",
      method: "GET",
      path: "/v1/cards",
      query: { page_size: 20 },
      headers: { "api-version": "2026-07-01" },
    },
    projectNativeLithicCards,
  ),
  jsonResource(
    "List monitors",
    {
      providerId: "datadog",
      operationId: "provider.monitors.read",
      method: "GET",
      path: "/api/v1/monitor",
      query: { page: 0, page_size: 20 },
    },
    projectDatadogMonitors,
  ),
  jsonResource(
    "List payments",
    {
      providerId: "razorpay",
      operationId: "provider.payments.read",
      method: "GET",
      path: "/v1/payments",
      query: { count: 20, skip: 0 },
    },
    projectNativeRazorpayPayments,
  ),
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
