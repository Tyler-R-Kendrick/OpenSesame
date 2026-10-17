import { z } from "zod";
import { type AiConnectionDraft, AiConnectionError } from "./types.js";

function datedVersion(value: string): boolean {
  const date = value.slice(0, 10);
  const time = Date.parse(date);
  return (
    !Number.isNaN(time) && new Date(time).toISOString().slice(0, 10) === date
  );
}

const credential = z.enum(["api-key", "entra-token"]);
/** Shared public target schema for the later strict configuration/persistence slice. */
export const AzureOpenAiTargetSchema = z.discriminatedUnion("api", [
  z.object({ api: z.literal("v1"), credential }).strict(),
  z
    .object({
      api: z.literal("dated-chat"),
      credential,
      apiVersion: z
        .string()
        .max(18)
        .regex(/^\d{4}-\d{2}-\d{2}(?:-preview)?$/)
        .refine(datedVersion),
    })
    .strict(),
]);

function invalidTarget(): never {
  throw new AiConnectionError(
    "configuration",
    "Check the Azure endpoint, deployment, API mode and authentication.",
  );
}

/** Azure is a target for existing OpenAI families, never another provider's auth. */
export function azureConnectionTarget(draft: AiConnectionDraft) {
  if (draft.azure === undefined) {
    if (draft.providerId === "azure-openai") return invalidTarget();
    return null;
  }
  const parsed = AzureOpenAiTargetSchema.safeParse(draft.azure);
  if (!parsed.success) return invalidTarget();
  if (
    !["azure-openai", "byo-ai"].includes(draft.providerId) ||
    !["openai_chat", "openai_responses"].includes(draft.family) ||
    draft.authentication !== "api-key" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]{0,159}$/.test(draft.model)
  )
    return invalidTarget();
  const target = parsed.data;
  if (target.api === "dated-chat" && draft.family !== "openai_chat")
    return invalidTarget();
  if (
    draft.apiKey.length >= 4 &&
    [draft.name, draft.baseUrl, draft.model, JSON.stringify(target)].some(
      (field) => field.includes(draft.apiKey),
    )
  )
    return invalidTarget();
  return target;
}

/** Caller supplies its existing normalized resource base, including any custom mount. */
export function azureInferenceUrl(
  draft: AiConnectionDraft,
  base: URL,
): URL | null {
  const target = azureConnectionTarget(draft);
  if (!target) return null;
  const path =
    target.api === "dated-chat"
      ? `openai/deployments/${draft.model}/chat/completions`
      : `openai/v1/${draft.family === "openai_chat" ? "chat/completions" : "responses"}`;
  const url = new URL(path, base);
  if (target.api === "dated-chat")
    url.searchParams.set("api-version", target.apiVersion);
  return url;
}

/** The write-only credential field holds either an Azure key or a supplied Entra token. */
export function azureConnectionHeaders(
  draft: AiConnectionDraft,
): Headers | null {
  const target = azureConnectionTarget(draft);
  if (!target) return null;
  if (!/^[!-~]{1,16384}$/.test(draft.apiKey))
    throw new AiConnectionError(
      "authentication",
      "Enter an Azure key or Entra access token without spaces or control characters.",
    );
  const headers = new Headers({ "content-type": "application/json" });
  if (target.credential === "api-key") headers.set("api-key", draft.apiKey);
  else headers.set("authorization", `Bearer ${draft.apiKey}`);
  return headers;
}
