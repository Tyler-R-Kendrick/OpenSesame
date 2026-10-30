import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { z } from "zod";
import { parseGcpServiceAccount } from "../native-gcp-auth.js";
import { validateAssemblySpeechTarget } from "./assemblyai-target.js";
import {
  AzureOpenAiTargetSchema,
  azureConnectionTarget,
} from "./azure-protocol.js";
import { aiConnectionBase } from "./base-url.js";
import {
  BedrockAiTargetSchema,
  bedrockConnectionTarget,
  bedrockCredential,
} from "./bedrock-target.js";
import { validateDeepgramSpeechTarget } from "./deepgram-target.js";
import { aiConnectionFamilies, aiConnectionPreset } from "./presets.js";
import { replicatePredictionTarget } from "./replicate-types.js";
import { validateAiSpeechConnection } from "./speech-target.js";
import { validateAiStabilityConnection } from "./stability-target.js";
import {
  type AiConnectionDraft,
  AiConnectionError,
  isAiImageFamily,
  isAiSpeechFamily,
} from "./types.js";
import {
  VertexAiTargetSchema,
  vertexConnectionTarget,
  vertexInferenceUrl,
} from "./vertex-target.js";

export const AiConnectionDraftSchema = z
  .object({
    providerId: z.string().min(1).max(100),
    name: z.string().trim().min(1).max(200),
    family: z.enum([
      "stability_sd3",
      "replicate_predictions",
      "elevenlabs_scribe",
      "deepgram_listen",
      "assemblyai_transcript",
      "bedrock_converse",
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
    vertex: VertexAiTargetSchema.optional(),
    bedrock: BedrockAiTargetSchema.optional(),
  })
  .strict();

export { aiConnectionBase } from "./base-url.js";

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
  validateFamilyTarget(draft, requireKey);
  draft.baseUrl = aiConnectionBase(draft.baseUrl).href.replace(/\/$/, "");
  validateReplicateTarget(draft);
  azureConnectionTarget(draft);
  if (
    draft.family === "gemini_generate_content" &&
    !/^[A-Za-z0-9._-]+$/.test(draft.model)
  )
    throw new AiConnectionError(
      "configuration",
      "Enter a Gemini model identifier without path segments.",
    );
  validateCredential(draft, requireKey);
  return draft;
}

function validateFamilyTarget(
  draft: AiConnectionDraft,
  requireKey: boolean,
): void {
  const preset = aiConnectionPreset(draft.providerId);
  const speech = isAiSpeechFamily(draft.family);
  const image = isAiImageFamily(draft.family);
  if (image || draft.providerId === "stability")
    validateAiStabilityConnection(draft, requireKey);
  if (draft.family === "elevenlabs_scribe")
    validateAiSpeechConnection(draft, requireKey);
  if (draft.family === "assemblyai_transcript")
    validateAiAssemblyConnection(draft, requireKey);
  if (draft.family === "deepgram_listen")
    validateAiDeepgramConnection(draft, requireKey);
  const supportedFamily =
    image ||
    speech ||
    (draft.family === "replicate_predictions"
      ? ["replicate", "byo-ai"].includes(draft.providerId)
      : draft.family === "bedrock_converse"
        ? ["aws-bedrock", "byo-ai"].includes(draft.providerId)
        : aiConnectionFamilies(draft.providerId).some(
            (family) => family.id === draft.family,
          ));
  if ((!preset && !speech && !image) || !supportedFamily)
    throw new AiConnectionError(
      "configuration",
      "Choose a protocol supported by this provider.",
    );
}

/** Shared admission and inference select the same closed raw-audio target. */
export function validateAiDeepgramConnection(
  draft: AiConnectionDraft,
  requireKey = true,
) {
  if (
    draft.family !== "deepgram_listen" ||
    draft.azure ||
    draft.vertex ||
    draft.bedrock
  )
    throw new AiConnectionError(
      "configuration",
      "Choose a single Deepgram transcription target without another protocol's credentials.",
    );
  return validateDeepgramSpeechTarget(
    {
      providerId: draft.providerId,
      baseUrl: draft.baseUrl,
      model: draft.model,
      authentication: draft.authentication,
      apiKey: draft.apiKey,
    },
    requireKey,
  );
}

/** Saved admission and useful inference share the closed finite-job speech target. */
export function validateAiAssemblyConnection(
  draft: AiConnectionDraft,
  requireKey = true,
) {
  if (
    draft.family !== "assemblyai_transcript" ||
    draft.azure ||
    draft.vertex ||
    draft.bedrock
  )
    throw new AiConnectionError(
      "configuration",
      "Choose a single AssemblyAI transcription target without another protocol's credentials.",
    );
  return validateAssemblySpeechTarget(
    {
      providerId: draft.providerId,
      baseUrl: draft.baseUrl,
      model: draft.model,
      authentication: draft.authentication,
      apiKey: draft.apiKey,
    },
    requireKey,
  );
}

function validateReplicateTarget(draft: AiConnectionDraft): void {
  if (draft.family !== "replicate_predictions") {
    if (draft.providerId === "replicate")
      throw new AiConnectionError(
        "configuration",
        "Choose the Replicate predictions family for this provider.",
      );
    return;
  }
  if (
    !["replicate", "byo-ai"].includes(draft.providerId) ||
    draft.authentication !== "api-key" ||
    draft.azure ||
    draft.vertex ||
    draft.bedrock
  )
    throw new AiConnectionError(
      "configuration",
      "Choose one Replicate prediction target with an API token.",
    );
  replicatePredictionTarget(draft.model);
}
function normalizeVertexCredential(draft: AiConnectionDraft): boolean {
  const vertex = vertexConnectionTarget(draft);
  if (vertex)
    vertexInferenceUrl({ ...draft, vertex }, aiConnectionBase(draft.baseUrl));
  const privateDocument = vertex?.credential === "service-account";
  if (privateDocument && draft.apiKey) {
    const account = parseGcpServiceAccount(draft.apiKey);
    if (
      [draft.name, draft.baseUrl, draft.model, JSON.stringify(vertex)].some(
        (value) => value.includes(account.privateKey),
      )
    )
      throw new AiConnectionError(
        "configuration",
        "Keep the private key out of public connection fields.",
      );
    draft.apiKey = JSON.stringify({
      type: "service_account",
      client_email: account.clientEmail,
      project_id: account.projectId,
      private_key: account.privateKey,
    });
  }
  return privateDocument;
}
function configuredBedrock(draft: AiConnectionDraft) {
  if (draft.family === "bedrock_converse")
    return bedrockConnectionTarget({ ...draft, family: "bedrock_converse" });
  if (draft.bedrock || draft.providerId === "aws-bedrock")
    throw new AiConnectionError(
      "configuration",
      "Choose the Bedrock Converse family for this target.",
    );
  return null;
}
function normalizeBedrockCredential(draft: AiConnectionDraft): boolean {
  const target = configuredBedrock(draft);
  if (!target) return false;
  if (draft.apiKey) {
    const credential = bedrockCredential(draft.apiKey);
    const publicFields = [
      draft.name,
      draft.baseUrl,
      draft.model,
      JSON.stringify(target),
    ];
    if (
      [
        credential.accessKeyId,
        credential.secretAccessKey,
        credential.sessionToken ?? "",
      ].some(
        (secret) =>
          secret.length >= 4 &&
          publicFields.some((value) => value.includes(secret)),
      )
    )
      throw new AiConnectionError(
        "configuration",
        "Keep AWS credentials out of public connection fields.",
      );
    draft.apiKey = JSON.stringify(credential);
  }
  return true;
}
function validateCredential(
  draft: AiConnectionDraft,
  requireKey: boolean,
): void {
  const bedrockDocument = normalizeBedrockCredential(draft);
  const privateDocument = normalizeVertexCredential(draft) || bedrockDocument;
  if (!privateDocument && draft.apiKey && !/^[!-~]+$/.test(draft.apiKey))
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
  const publicBinding = target
    ? [
        ...legacy,
        [
          "azure-openai",
          target.api,
          target.api === "dated-chat" ? target.apiVersion : null,
          target.credential,
        ],
      ]
    : legacy;
  const vertex = vertexConnectionTarget(draft);
  const vertexBinding = vertex
    ? [
        ...publicBinding,
        ["google-vertex", vertex.project, vertex.location, vertex.credential],
      ]
    : publicBinding;
  const bedrock = configuredBedrock(draft);
  return JSON.stringify(
    bedrock
      ? [...vertexBinding, ["aws-bedrock", bedrock.region, bedrock.credential]]
      : vertexBinding,
  );
}

export function aiCredentialDigest(value: string): string {
  return bytesToHex(sha256(new TextEncoder().encode(value)));
}
