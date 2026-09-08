/** Task metadata reachable with an explicitly approved host.tasks.read grant. */
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { hostFetch } from "./host-api.js";
import { agentJson, safeTokenSchema, textContent, toolError } from "./tools.js";

export function registerReadTools(server: McpServer): void {
  const responseSchema = z.object({
    tasks: z
      .array(
        z.object({
          task_run_id: safeTokenSchema,
          state_version: z.number().int().nonnegative().optional(),
          status: safeTokenSchema.optional(),
        }),
      )
      .max(256),
  });
  server.tool(
    "task_list",
    "List the caller's task metadata; never intents or secrets",
    {},
    async () => {
      try {
        const response = await hostFetch("/api/v1/tasks");
        return {
          content: textContent(
            agentJson(await response.json(), response.ok, responseSchema),
          ),
          isError: !response.ok,
        };
      } catch (error) {
        return toolError(
          "task_list_failed",
          error instanceof Error ? error : String(error),
        );
      }
    },
  );
}
