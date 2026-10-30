/** Finite AWS Converse over the original captured AI authority and signer. */
import { sha256 } from "@noble/hashes/sha2.js";
import { bytesToHex } from "@noble/hashes/utils.js";
import { Redacted } from "effect";
import { z } from "zod";
import { aiCompletionSeams } from "../ai-completion-observation.js";
import {
  type HostedModelInput,
  hostedModelRequest,
} from "../hosted-model-protocol.js";
import { signAws } from "../secret-fs/s3-sigv4.js";
import {
  type BedrockAiDraft,
  bedrockConnectionTarget,
  bedrockCredential,
  bedrockInferenceUrl,
} from "./bedrock-target.js";
import { aiConnectionBase } from "./configuration.js";
import { checkAiResponse, readAiJson } from "./http.js";
import { AiConnectionError, type AiConnectionTransport } from "./types.js";
const Answer = z.object({
  output: z.object({
    message: z.object({
      role: z.literal("assistant"),
      content: z.array(z.object({ text: z.string().min(1) }).strict()).min(1),
    }),
  }),
  stopReason: z.enum(["end_turn", "max_tokens", "stop_sequence"]),
});
type ConverseBody = {
  messages: { role: "user" | "assistant"; content: { text: string }[] }[];
  system?: { text: string }[];
  inferenceConfig: { maxTokens: number };
};
function converseBody(input: HostedModelInput) {
  hostedModelRequest("anthropic", input);
  const messages = input.messages
    .filter((message) => message.role !== "system")
    .map((message) => ({
      role:
        message.role === "assistant"
          ? ("assistant" as const)
          : ("user" as const),
      content: [{ text: message.content }],
    }));
  if (!messages.length || messages[0]?.role !== "user")
    throw new AiConnectionError(
      "configuration",
      "Start the Bedrock conversation with a user question.",
    );
  const system = input.messages
    .filter((message) => message.role === "system")
    .map((message) => ({ text: message.content }));
  const body: ConverseBody = {
    messages,
    inferenceConfig: { maxTokens: input.maxOutputTokens ?? 1024 },
  };
  if (system.length) body.system = system;
  return JSON.stringify(body);
}
function signRequest(draft: BedrockAiDraft, body: string) {
  const target = bedrockConnectionTarget(draft);
  const credential = bedrockCredential(draft.apiKey);
  return signAws({
    method: "POST",
    url: bedrockInferenceUrl(draft, aiConnectionBase(draft.baseUrl)),
    headers: new Headers({ "content-type": "application/json" }),
    payloadHash: bytesToHex(sha256(new TextEncoder().encode(body))),
    region: target.region,
    service: "bedrock",
    payloadHashHeader: false,
    pathEncoding: "twice",
    credentials: {
      accessKeyId: credential.accessKeyId,
      secretAccessKey: Redacted.make(credential.secretAccessKey),
      sessionToken: credential.sessionToken
        ? Redacted.make(credential.sessionToken)
        : undefined,
    },
  });
}
export async function inferBedrockAi(
  draft: BedrockAiDraft,
  input: HostedModelInput,
  transport: AiConnectionTransport,
  check: () => void,
  onText?: (text: string) => void,
) {
  const current = () => {
    check();
    transport.assertCurrent();
    transport.signal.throwIfAborted();
  };
  current();
  bedrockConnectionTarget(draft);
  if (input.model !== draft.model)
    throw new AiConnectionError(
      "configuration",
      "Use the model saved with this connection.",
    );
  const credential = bedrockCredential(draft.apiKey);
  const body = converseBody(input);
  const signed = signRequest(draft, body);
  current();
  const signal = AbortSignal.any([
    transport.signal,
    AbortSignal.timeout(30_000),
  ]);
  let response: Response;
  try {
    response = await transport.fetch(signed.url, {
      method: "POST",
      headers: signed.headers,
      body,
      signal,
      credentials: "omit",
      redirect: "error",
      cache: "no-store",
      referrerPolicy: "no-referrer",
    });
  } catch {
    current();
    throw new AiConnectionError(
      "network",
      "Could not complete this Bedrock request.",
    );
  }
  try {
    current();
    checkAiResponse(response);
  } catch (error) {
    await response.body?.cancel().catch(() => undefined);
    throw error;
  }
  aiCompletionSeams.observe?.({
    phase: "request",
    response,
    owner: check,
    httpSignal: signal,
    transportSignal: transport.signal,
  });
  const value = Answer.parse(await readAiJson(response, current));
  current();
  const answer = value.output.message.content
    .map((part) => part.text)
    .join("\n")
    .trim();
  if (
    !answer ||
    answer.length > 32768 ||
    [
      draft.apiKey,
      credential.accessKeyId,
      credential.secretAccessKey,
      credential.sessionToken ?? "",
    ].some((secret) => secret.length >= 4 && answer.includes(secret))
  )
    throw new AiConnectionError(
      "response",
      "The model did not return a safe text answer.",
    );
  current();
  onText?.(answer);
  current();
  return { providerId: draft.providerId, model: draft.model, answer };
}
