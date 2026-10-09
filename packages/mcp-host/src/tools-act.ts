/** Ciphertext-only operations; human administration is not an MCP authority tier. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readSyncPage } from "@opensesame/api-client";
import { z } from "zod";
import { hostFetch } from "./host-api.js";
import { agentJson, safeTokenSchema, textContent, toolError } from "./tools.js";

export function registerActTools(server: McpServer): void {
  const cursor = z.object({
    epoch: z.number().int().nonnegative(),
    id: z.string().max(512),
  });
  const pushResponse = z.object({
    accepted: z.number().int().nonnegative().optional(),
    rejected_foreign_owner: z.number().int().nonnegative().optional(),
    rejected_oversize: z.number().int().nonnegative().optional(),
    rejected_session_quota: z.number().int().nonnegative().optional(),
    rejected_stale_epoch: z.number().int().nonnegative().optional(),
    rejected_batch: z.number().int().nonnegative().optional(),
    owner_capacity: z.number().int().nonnegative().optional(),
    max_ciphertext_bytes: z.number().int().nonnegative().optional(),
  });
  const pullResponse = z.object({
    blobs: z
      .array(
        z.object({
          id: safeTokenSchema,
          epoch: z.number().int().nonnegative(),
          ciphertext_b64: z.string().max(2_796_204),
          ciphertext_epoch: z.number().int().nonnegative(),
        }),
      )
      .max(64),
    next_after: cursor.nullable(),
    has_more: z.boolean(),
  });
  server.tool(
    "sync_push",
    "Push encrypted ciphertext to the caller's Host sync store",
    {
      blobs: z
        .array(
          z.object({
            id: safeTokenSchema,
            epoch: z.number().int().nonnegative(),
            ciphertext_b64: z
              .string()
              .min(1)
              .max(2_796_204)
              .regex(
                /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/,
              ),
          }),
        )
        .min(1)
        .max(64),
    },
    async ({ blobs }) => {
      try {
        const response = await hostFetch("/api/v1/sync/push", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            blobs: blobs.map((blob) => ({
              id: blob.id,
              epoch: blob.epoch,
              ciphertext: Array.from(
                Buffer.from(blob.ciphertext_b64, "base64"),
              ),
            })),
          }),
        });
        return {
          content: textContent(
            agentJson(await response.json(), response.ok, pushResponse),
          ),
          isError: !response.ok,
        };
      } catch (error) {
        return toolError(
          "sync_push_failed",
          error instanceof Error ? error : String(error),
        );
      }
    },
  );
  server.tool(
    "sync_pull",
    "Pull one bounded ciphertext page; continue with next_after while has_more is true",
    {
      since_epoch: z.number().int().nonnegative().optional(),
      after: cursor.optional(),
      device_id: safeTokenSchema.optional(),
    },
    async ({ since_epoch, after, device_id }) => {
      try {
        const body = await readSyncPage(
          hostFetch,
          after ?? { epoch: (since_epoch ?? 0) + 1, id: "" },
          device_id,
        );
        return {
          content: textContent(agentJson(body, true, pullResponse)),
          isError: false,
        };
      } catch (error) {
        return toolError(
          "sync_pull_failed",
          error instanceof Error ? error : String(error),
        );
      }
    },
  );
}
