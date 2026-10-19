/** Bedrock Converse is its own protocol; credentials remain write-only. */
import { z } from "zod";
import { type AiConnectionDraft, AiConnectionError } from "./types.js";
export const BedrockAiTargetSchema = z
  .object({
    region: z.string().regex(/^[a-z]{2}(?:-[a-z]+)+-\d$/),
    credential: z.literal("sigv4"),
  })
  .strict();
export type BedrockAiTarget = z.infer<typeof BedrockAiTargetSchema>;
export type BedrockAiDraft = Omit<AiConnectionDraft, "family"> & {
  family: "bedrock_converse";
  bedrock?: BedrockAiTarget;
};
export const BedrockCredentialSchema = z
  .object({
    accessKeyId: z.string().regex(/^[A-Z0-9]{16,128}$/),
    secretAccessKey: z
      .string()
      .min(20)
      .max(256)
      .regex(/^[A-Za-z0-9/+=]+$/),
    sessionToken: z
      .string()
      .min(16)
      .max(8192)
      .regex(/^[\x21-\x7e]+$/)
      .optional(),
  })
  .strict();
export function bedrockResourceBase(target: BedrockAiTarget) {
  return `https://bedrock-runtime.${target.region}.amazonaws.com/`;
}
export function bedrockConnectionTarget(draft: BedrockAiDraft) {
  const target = BedrockAiTargetSchema.parse(draft.bedrock);
  if (
    !["aws-bedrock", "byo-ai"].includes(draft.providerId) ||
    draft.family !== "bedrock_converse" ||
    draft.authentication !== "api-key" ||
    draft.azure ||
    draft.vertex ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,159}$/.test(draft.model)
  )
    throw new AiConnectionError(
      "configuration",
      "Choose a valid Bedrock Converse target.",
    );
  if (
    draft.providerId === "aws-bedrock" &&
    draft.baseUrl.replace(/\/+$/, "") !==
      bedrockResourceBase(target).replace(/\/$/, "")
  )
    throw new AiConnectionError(
      "configuration",
      "Use the regional Bedrock runtime endpoint.",
    );
  return target;
}
export function bedrockInferenceUrl(draft: BedrockAiDraft, base: URL) {
  bedrockConnectionTarget(draft);
  return new URL(`model/${encodeURIComponent(draft.model)}/converse`, base);
}

export function bedrockCredential(value: string) {
  try {
    return BedrockCredentialSchema.parse(JSON.parse(value));
  } catch {
    throw new AiConnectionError(
      "authentication",
      "Enter valid AWS credential JSON.",
    );
  }
}
