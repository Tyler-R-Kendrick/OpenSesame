/** Vertex targets reuse the existing Gemini protocol and write-only vault credential. */
import { z } from "zod";
import { isGcpProjectId } from "../native-gcp-auth.js";
import { type AiConnectionDraft, AiConnectionError } from "./types.js";
export const VertexAiTargetSchema = z
  .object({
    project: z.string().refine(isGcpProjectId),
    location: z.string().regex(/^(?:global|[a-z]+(?:-[a-z0-9]+)*[0-9])$/),
    credential: z.enum(["service-account", "access-token"]),
  })
  .strict();
export type VertexAiTarget = z.infer<typeof VertexAiTargetSchema>;
export type VertexAiDraft = AiConnectionDraft & { vertex: VertexAiTarget };
function invalid(): never {
  throw new AiConnectionError(
    "configuration",
    "Check the Vertex project, location, Gemini model and authentication.",
  );
}
export function vertexConnectionTarget(
  draft: AiConnectionDraft & { vertex?: VertexAiTarget },
) {
  if (!draft.vertex) {
    if (draft.providerId === "google-vertex") return invalid();
    return null;
  }
  const target = VertexAiTargetSchema.safeParse(draft.vertex);
  if (
    !target.success ||
    !["google-vertex", "byo-ai"].includes(draft.providerId) ||
    draft.family !== "gemini_generate_content" ||
    draft.authentication !== "api-key" ||
    draft.azure ||
    !/^[A-Za-z0-9._-]+$/.test(draft.model)
  )
    return invalid();
  if (
    draft.apiKey.length >= 4 &&
    [draft.name, draft.model, draft.baseUrl, JSON.stringify(target.data)].some(
      (value) => value.includes(draft.apiKey),
    )
  )
    return invalid();
  return target.data;
}
export function vertexResourceBase(target: VertexAiTarget): string {
  const host =
    target.location === "global"
      ? "aiplatform.googleapis.com"
      : `${target.location}-aiplatform.googleapis.com`;
  return `https://${host}/v1`;
}
export function vertexInferenceUrl(draft: VertexAiDraft, base: URL): URL {
  const target = vertexConnectionTarget(draft);
  if (!target) return invalid();
  if (
    draft.providerId === "google-vertex" &&
    base.href !== `${vertexResourceBase(target)}/`
  )
    return invalid();
  return new URL(
    `projects/${target.project}/locations/${target.location}/publishers/google/models/${draft.model}:generateContent`,
    base,
  );
}
