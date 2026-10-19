/** Read-only SMS inventory and default bot commands; no sending or update consumption. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import { NativeApiError } from "./native-api-http.js";
import {
  type Resource,
  jsonResource,
  projectResourceCollection,
  resourceId,
  resourceText,
} from "./native-api-resource.js";
import { zodJitless } from "./zod-jitless.js";

zodJitless();
const failed = {
  error: z.never().optional(),
  errors: z.never().optional(),
  message: z.never().optional(),
  status: z.never().optional(),
  code: z.never().optional(),
  success: z.literal(true).optional(),
};
const count = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const messages = z.object({
  items: z
    .array(z.object({ id: resourceId, direction: z.enum(["mt", "mo"]) }))
    .max(20),
  offset: z.literal(0),
  limit: z.literal(20),
  count: count.max(20),
  totalCount: count,
  ok: z.literal(true).optional(),
  ...failed,
});
const commands = z.object({
  ok: z.literal(true),
  result: z
    .array(
      z.object({
        command: z.string().regex(/^[a-z0-9_]{1,32}$/),
        description: resourceText.refine((value) => [...value].length <= 256),
      }),
    )
    .max(100),
  ...failed,
});
export function projectMessagebirdMessages(body: BoundaryValue) {
  const response = messages.parse(body);
  if (
    response.count !== response.items.length ||
    response.totalCount < response.count
  )
    throw new NativeApiError("response");
  return projectResourceCollection(
    response.items.map(({ id, direction }) => ({
      id,
      label: direction === "mt" ? "Outbound SMS" : "Inbound SMS",
    })),
    "messages",
    "first-page",
  );
}
export function projectTelegramCommands(body: BoundaryValue) {
  return projectResourceCollection(
    commands.parse(body).result.map(({ command, description }) => ({
      id: command,
      label: `/${command} — ${description}`,
    })),
    "default bot commands",
    "returned",
  );
}
export const nativeMessagingInventories: readonly Resource[] = [
  jsonResource(
    "List messages",
    {
      providerId: "messagebird",
      operationId: "provider.messages.read",
      method: "GET",
      path: "/messages",
      query: { limit: 20, offset: 0 },
      headers: { Accept: "application/json" },
    },
    projectMessagebirdMessages,
  ),
  jsonResource(
    "List default bot commands",
    {
      providerId: "telegram",
      operationId: "provider.bot-commands.read",
      method: "GET",
      path: "/getMyCommands",
      headers: { Accept: "application/json" },
    },
    projectTelegramCommands,
  ),
];
