import { sha256 } from "@noble/hashes/sha2";
import { bytesToHex } from "@noble/hashes/utils";
import { z } from "zod";
import {
  AzureOpenAiTargetSchema,
  azureConnectionTarget,
} from "./azure-protocol.js";
import { aiConnectionFamilies, aiConnectionPreset } from "./presets.js";
import { type AiConnectionDraft, AiConnectionError } from "./types.js";

export const AiConnectionDraftSchema = z
  .object({
    providerId: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(200),
    family: z.enum([
      "openai_chat",
      "openai_responses",
      "anthropic_messages",
      "gemini_generate_content",
    ]),
    baseUrl: z.string().min(1).max(2048),
    model: z
      .string()
      .trim()
      .min(1)
      .max(160)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/),
    authentication: z.enum(["api-key", "none"]),
    apiKey: z.string().max(16384),
    tokenParameter: z
      .enum(["max_tokens", "max_completion_tokens"])
      .default("max_completion_tokens"),
    azure: AzureOpenAiTargetSchema.optional(),
  })
  .strict();

export function aiConnectionBase(value: string): URL {
  let base: URL;
  try {
    base = new URL(value.trim());
  } catch {
    throw new AiConnectionError(
      "configuration",
      "Enter a complete AI API base URL.",
    );
  }
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(base.hostname);
  if (
    !(base.protocol === "https:" || (base.protocol === "http:" && loopback)) ||
    base.username ||
    base.password ||
    base.search ||
    base.hash ||
    /[\\\r\n]/.test(value) ||
    /%2e|%2f|%5c/i.test(value)
  )
    throw new AiConnectionError(
      "configuration",
      "Use HTTPS, or loopback HTTP, without URL credentials, query or fragment.",
    );
  base.pathname = `${base.pathname.replace(/\/+$/, "")}/`;
  return base;
}

export function validateAiConnection<Value>(
  value: Value,
  requireKey = true,
): AiConnectionDraft {
  const result = AiConnectionDraftSchema.safeParse(value);
  if (!result.success)
    throw new AiConnectionError(
      "configuration",
      "Check the AI connection fields.",
    );
  const draft = result.data;
  const preset = aiConnectionPreset(draft.providerId);
  if (
    !preset ||
    !aiConnectionFamilies(draft.providerId).some(
      (family) => family.id === draft.family,
    )
  )
    throw new AiConnectionError(
      "configuration",
      "Choose a protocol supported by this provider.",
    );
  draft.baseUrl = aiConnectionBase(draft.baseUrl).href.replace(/\/$/, "");
  azureConnectionTarget(draft);
  if (
    draft.family === "gemini_generate_content" &&
    !/^[A-Za-z0-9._-]+$/.test(draft.model)
  )
    throw new AiConnectionError(
      "configuration",
      "Enter a Gemini model identifier without path segments.",
    );
  if (draft.apiKey && !/^[!-~]+$/.test(draft.apiKey))
    throw new AiConnectionError(
      "configuration",
      "Enter an API key without spaces or control characters.",
    );
  if (draft.authentication === "none") draft.apiKey = "";
  if (requireKey && draft.authentication === "api-key" && !draft.apiKey)
    throw new AiConnectionError(
      "configuration",
      "Enter an API key for this connection.",
    );
  if (
    draft.apiKey.length >= 4 &&
    [draft.name, draft.baseUrl, draft.model].some((field) =>
      field.includes(draft.apiKey),
    )
  )
    throw new AiConnectionError(
      "configuration",
      "Keep the API key out of public connection fields.",
    );
  return draft;
}

export function aiConnectionBinding(draft: AiConnectionDraft): string {
  const legacy = [
    draft.providerId,
    draft.family,
    draft.baseUrl,
    draft.model,
    draft.authentication,
    draft.tokenParameter,
  ];
  const target = azureConnectionTarget(draft);
  return JSON.stringify(
    target
      ? [
          ...legacy,
          [
            "azure-openai",
            target.api,
            target.api === "dated-chat" ? target.apiVersion : null,
            target.credential,
          ],
        ]
      : legacy,
  );
}

export function aiCredentialDigest(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)));
}
