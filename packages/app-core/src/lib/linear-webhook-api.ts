/** Explicit webhook provisioning against Linear; the receiving URL is caller-owned. */
import type { JsonObject } from "@opensesame/os-domain";
import { z } from "zod";
import {
  LinearApiError,
  type LinearCredential,
  linearGraphql,
  linearInput,
} from "./linear-http.js";

const Resource = z.enum([
  "Issue",
  "Comment",
  "IssueLabel",
  "Project",
  "Cycle",
  "Reaction",
]);
const CreateWebhook = z.object({
  url: z
    .string()
    .url()
    .max(2048)
    .refine((value) => {
      const url = new URL(value);
      return (
        url.protocol === "https:" && !url.username && !url.password && !url.hash
      );
    }),
  resourceTypes: z.array(Resource).min(1).max(6),
  teamId: z.string().trim().min(1).max(256).optional(),
  label: z.string().trim().max(256).optional(),
  secret: z.string().min(32).max(1024).optional(),
  id: z.string().uuid().optional(),
});
const Webhook = z.object({
  id: z.string().min(1).max(256),
  enabled: z.literal(true),
});
export type LinearWebhook = z.infer<typeof Webhook>;
export type CreateLinearWebhookInput = {
  url: string;
  resourceTypes: string[];
  teamId?: string;
  label?: string;
  secret?: string;
  id?: string;
};

/** Creating OAuth webhooks requires the actual admin grant from Linear. */
export async function createLinearWebhook(
  credential: LinearCredential,
  input: CreateLinearWebhookInput,
): Promise<LinearWebhook> {
  const checked = linearInput(CreateWebhook, input);
  const webhookInput: JsonObject = {
    ...checked,
    resourceTypes: [...new Set(checked.resourceTypes)],
  };
  if (!checked.teamId) webhookInput.allPublicTeams = true;
  const reply = await linearGraphql(
    credential,
    "mutation OpenSesameWebhook($input: WebhookCreateInput!) { webhookCreate(input: $input) { success webhook { id enabled } } }",
    { input: webhookInput },
    z.object({
      webhookCreate: z.object({ success: z.literal(true), webhook: Webhook }),
    }),
  );
  return reply.webhookCreate.webhook;
}

export async function deleteLinearWebhook(
  credential: LinearCredential,
  id: string,
): Promise<void> {
  const checked = linearInput(z.string().trim().min(1).max(256), id);
  await linearGraphql(
    credential,
    "mutation OpenSesameDeleteWebhook($id: String!) { webhookDelete(id: $id) { success } }",
    { id: checked },
    z.object({ webhookDelete: z.object({ success: z.literal(true) }) }),
  );
}

const WebhookMetadata = z.object({
  id: z.string().min(1).max(256),
  enabled: z.boolean(),
  url: z.string().url().nullable(),
  label: z.string().max(256).nullable(),
  resourceTypes: z.array(z.string().max(128)).max(64),
});
export type LinearWebhookMetadata = z.infer<typeof WebhookMetadata>;
const WebhookPage = z.object({
  webhooks: z.object({
    nodes: z.array(WebhookMetadata).max(100),
    pageInfo: z.object({
      hasNextPage: z.boolean(),
      endCursor: z.string().nullable(),
    }),
  }),
});

/** Read existing subscriptions before reconciling a retry or a configuration edit. */
export async function listLinearWebhooks(
  credential: LinearCredential,
): Promise<LinearWebhookMetadata[]> {
  const found: LinearWebhookMetadata[] = [];
  let after: string | null = null;
  for (let page = 0; page < 10; page += 1) {
    const reply: z.infer<typeof WebhookPage> = await linearGraphql(
      credential,
      "query OpenSesameWebhooks($after: String) { webhooks(first: 100, after: $after) { nodes { id enabled url label resourceTypes } pageInfo { hasNextPage endCursor } } }",
      { after },
      WebhookPage,
    );
    found.push(...reply.webhooks.nodes);
    const cursor = reply.webhooks.pageInfo;
    if (!cursor.hasNextPage) return found;
    if (!cursor.endCursor || cursor.endCursor === after)
      throw new LinearApiError("response");
    after = cursor.endCursor;
  }
  throw new LinearApiError("response");
}
