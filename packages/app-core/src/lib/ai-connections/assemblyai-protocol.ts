/** Official prerecorded upload/create/get/delete; response URLs never authorize fetch. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { z } from "zod";
import {
  type AssemblySpeechTarget,
  assemblyTranscriptId,
} from "./assemblyai-target.js";
import { aiConnectionBase } from "./configuration.js";
import { aiProtocolFetch, readAiJson } from "./http.js";
import { AiConnectionError, type AiConnectionTransport } from "./types.js";

const Job = z.object({
  id: z.string(),
  status: z.enum(["queued", "processing", "completed", "error"]),
  text: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  errors: z.undefined().optional(),
  is_deleted: z.literal(false).optional(),
  speech_model_used: z
    .string()
    .regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/)
    .nullable()
    .optional(),
});
export type AssemblyTranscript = z.infer<typeof Job>;

function unsafe(): never {
  throw new AiConnectionError(
    "response",
    "The transcription service returned an invalid or unsafe response.",
  );
}
function secretFree(value: BoundaryValue, key: string): void {
  if (JSON.stringify(value).includes(key)) unsafe();
}

/** This opaque HTTPS value is sent only in the captured origin's create body. */
export function assemblyUploadHandle(
  value: BoundaryValue,
  target: AssemblySpeechTarget,
): string {
  secretFree(value, target.apiKey);
  const parsed = z
    .object({ upload_url: z.string().min(1).max(2048) })
    .safeParse(value);
  if (!parsed.success) return unsafe();
  const handle = parsed.data.upload_url;
  try {
    const url = new URL(handle);
    if (
      url.protocol !== "https:" ||
      !url.hostname ||
      url.username ||
      url.password ||
      url.hash ||
      !/^[\x21-\x7e]+$/.test(handle) ||
      handle.includes("\\") ||
      decodeURIComponent(handle).includes(target.apiKey)
    )
      return unsafe();
  } catch {
    return unsafe();
  }
  return handle;
}

export function parseAssemblyTranscript(
  value: BoundaryValue,
  target: AssemblySpeechTarget,
  expectedId: string,
): AssemblyTranscript {
  secretFree(value, target.apiKey);
  if (assemblyTranscriptId(value, target) !== expectedId) return unsafe();
  const parsed = Job.safeParse(value);
  if (
    !parsed.success ||
    (parsed.data.speech_model_used &&
      parsed.data.speech_model_used !== target.model)
  )
    return unsafe();
  const job = parsed.data;
  if (job.status !== "error" && job.error) return unsafe();
  return job;
}

export function assemblyTranscriptText(job: AssemblyTranscript): string {
  const text = job.text?.trim();
  if (
    job.status !== "completed" ||
    job.error ||
    !text ||
    new TextEncoder().encode(text).byteLength > 32768
  )
    return unsafe();
  return text;
}

type AssemblyBody =
  | { mime: "application/json"; value: string }
  | { mime: "application/octet-stream"; value: ArrayBuffer };
type AssemblyRequest = Parameters<typeof aiProtocolFetch>[2];
async function request(
  target: AssemblySpeechTarget,
  path: string,
  method: "POST" | "GET" | "DELETE",
  transport: AiConnectionTransport,
  check: () => void,
  body?: AssemblyBody,
): Promise<BoundaryValue> {
  const headers = new Headers({
    authorization: target.apiKey,
    accept: "application/json",
  });
  const init: AssemblyRequest = { method, headers };
  if (body !== undefined) {
    headers.set("content-type", body.mime);
    init.body = body.value;
  }
  const response = await aiProtocolFetch(
    target,
    new URL(path, aiConnectionBase(target.baseUrl)),
    init,
    transport,
    check,
  );
  try {
    if (
      response.headers
        .get("content-type")
        ?.split(";")[0]
        ?.trim()
        .toLowerCase() !== "application/json"
    )
      return unsafe();
    return await readAiJson(response, check);
  } finally {
    await response.body?.cancel().catch(() => undefined);
  }
}

export async function uploadAssemblyAudio(
  target: AssemblySpeechTarget,
  bytes: ArrayBuffer,
  transport: AiConnectionTransport,
  check: () => void,
): Promise<string> {
  return assemblyUploadHandle(
    await request(target, "upload", "POST", transport, check, {
      mime: "application/octet-stream",
      value: bytes,
    }),
    target,
  );
}
export function createAssemblyTranscript(
  target: AssemblySpeechTarget,
  upload: string,
  transport: AiConnectionTransport,
  check: () => void,
): Promise<BoundaryValue> {
  return request(target, "transcript", "POST", transport, check, {
    mime: "application/json",
    value: JSON.stringify({
      audio_url: upload,
      speech_models: [target.model],
      language_code: "en",
    }),
  });
}
export function getAssemblyTranscript(
  target: AssemblySpeechTarget,
  id: string,
  transport: AiConnectionTransport,
  check: () => void,
): Promise<BoundaryValue> {
  assemblyTranscriptId({ id }, target);
  return request(target, `transcript/${id}`, "GET", transport, check);
}
export async function deleteAssemblyTranscript(
  target: AssemblySpeechTarget,
  id: string,
  transport: AiConnectionTransport,
  check: () => void,
): Promise<void> {
  assemblyTranscriptId({ id }, target);
  const value = await request(
    target,
    `transcript/${id}`,
    "DELETE",
    transport,
    check,
  );
  secretFree(value, target.apiKey);
  if (assemblyTranscriptId(value, target) !== id) return unsafe();
}
