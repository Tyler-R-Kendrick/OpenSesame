/** AgentMail resources use the saved connection and the common bounded API executor. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import { NativeApiError } from "./native-api-http.js";
import { executeNativeApiRequest } from "./native-api-operations.js";
import type { NativeApiReadResult } from "./native-api-verify.js";
import {
  type NativeProviderTransport,
  nativeProviderTransport,
} from "./native-connector-transport.js";

function printable(value: string): boolean {
  return [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 32 && code !== 127;
  });
}
const text = z.string().min(1).max(512).refine(printable);
const inboxResponse = z.object({
  count: z.number().int().min(0).max(20),
  inboxes: z
    .array(
      z.object({
        inbox_id: text,
        email: text,
        display_name: z.string().max(512).refine(printable).optional(),
      }),
    )
    .max(20),
  error: z.never().optional(),
  errors: z.never().optional(),
});
const readResult = z.object({
  label: z.string(),
  items: z.array(z.object({ id: z.string(), label: z.string() })).max(20),
});
function projectInboxes(body: BoundaryValue): BoundaryValue {
  const response = inboxResponse.parse(body);
  if (
    response.count !== response.inboxes.length ||
    new Set(response.inboxes.map((inbox) => inbox.inbox_id)).size !==
      response.count
  )
    throw new NativeApiError("response");
  return {
    label: `${response.count} ${response.count === 1 ? "inbox" : "inboxes"}`,
    items: response.inboxes.map((inbox) => ({
      id: inbox.inbox_id,
      label: inbox.display_name || inbox.email,
    })),
  };
}

/** UI input cannot replace a request target, credential, query, or projection. */
export async function readNativeAgentMailInboxes(
  id: string,
  input: Record<string, string>,
  transport: NativeProviderTransport = nativeProviderTransport(),
): Promise<NativeApiReadResult> {
  transport.assertCurrent();
  if (Object.keys(input).length)
    throw new Error("List inboxes does not accept request fields");
  const result = await executeNativeApiRequest(
    id,
    {
      providerId: "agentmail",
      operationId: "provider.inboxes.read",
      method: "GET",
      path: "/v0/inboxes",
      query: { limit: 20 },
    },
    {},
    projectInboxes,
    transport,
  );
  return readResult.parse(result);
}
