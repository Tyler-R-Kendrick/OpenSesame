/** Finite local-audio transcription and deletion; no saved family activation. */
import type { HostedModelResult } from "../hosted-model-protocol.js";
import {
  assemblyTranscriptText,
  createAssemblyTranscript,
  deleteAssemblyTranscript,
  getAssemblyTranscript,
  parseAssemblyTranscript,
  uploadAssemblyAudio,
} from "./assemblyai-protocol.js";
import {
  type AssemblySpeechTarget,
  AssemblyTranscriptInterrupted,
  assemblyTranscriptId,
  validateAssemblySpeechTarget,
} from "./assemblyai-target.js";
import { aiConnectionBase } from "./configuration.js";
import { aiFiniteProtocolAuthority } from "./http.js";
import { type AiAudioInput, validateAiAudio } from "./media.js";
import { AiConnectionError, type AiConnectionTransport } from "./types.js";

export type AssemblyRunOptions = {
  /** User cancel only; the original caller/route/vault owner remains separate. */
  signal?: AbortSignal;
  /** May narrow the 180s workflow budget, never extend it. */
  timeoutMs?: number;
};
function pause(signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      reject(new DOMException("Transcription waiting stopped.", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, 3000);
    signal.addEventListener("abort", abort, { once: true });
  });
}
/** Internal lifetime narrowing retains the original fetch receiver and authority. */
function operationPort(
  transport: AiConnectionTransport,
  check: () => void,
  signal: AbortSignal,
): AiConnectionTransport {
  const fetch = transport.fetch;
  return {
    signal,
    assertCurrent: check,
    fetch(input, init) {
      check();
      return fetch.call(transport, input, init);
    },
  };
}
async function completedText(
  target: AssemblySpeechTarget,
  initial: Parameters<typeof parseAssemblyTranscript>[0],
  id: string,
  transport: AiConnectionTransport,
  check: () => void,
): Promise<string> {
  let value = initial;
  for (let polls = 0; ; polls++) {
    check();
    const job = parseAssemblyTranscript(value, target, id);
    if (job.status === "completed") return assemblyTranscriptText(job);
    if (job.status === "error")
      throw new AiConnectionError(
        "response",
        "The AssemblyAI transcription failed.",
      );
    if (polls >= 60)
      throw new AiConnectionError(
        "response",
        "The transcription exceeded its finite polling bound.",
      );
    await pause(transport.signal);
    check();
    value = await getAssemblyTranscript(target, id, transport, check);
  }
}
async function cleanup(
  target: AssemblySpeechTarget,
  id: string | undefined,
  transport: AiConnectionTransport,
  check: () => void,
) {
  check();
  if (!id) return false;
  const lifetime = new AbortController();
  const signal = AbortSignal.any([
    transport.signal,
    AbortSignal.timeout(10_000),
    lifetime.signal,
  ]);
  const port = operationPort(transport, check, signal);
  try {
    await deleteAssemblyTranscript(target, id, port, () => {
      check();
      signal.throwIfAborted();
    });
    check();
    return true;
  } catch {
    check();
    return false;
  } finally {
    lifetime.abort();
  }
}

export async function inferAssemblyAi(
  target: AssemblySpeechTarget,
  supplied: AiAudioInput,
  transport: AiConnectionTransport,
  owner: () => void,
  options: AssemblyRunOptions = {},
): Promise<HostedModelResult> {
  const authority = aiFiniteProtocolAuthority(transport, owner);
  const valid = validateAssemblySpeechTarget(target);
  aiConnectionBase(valid.baseUrl);
  const bytes = new Uint8Array(validateAiAudio(supplied).bytes).buffer;
  const timeout = options.timeoutMs ?? 180_000;
  if (!Number.isInteger(timeout) || timeout < 100 || timeout > 180_000)
    throw new AiConnectionError(
      "configuration",
      "Choose a transcription workflow budget between 100ms and 180s.",
    );
  const signal = AbortSignal.any([
    transport.signal,
    AbortSignal.timeout(timeout),
    ...(options.signal ? [options.signal] : []),
  ]);
  const lifetime = new AbortController();
  const requestSignal = AbortSignal.any([signal, lifetime.signal]);
  const check = () => {
    authority();
    requestSignal.throwIfAborted();
  };
  const port = operationPort(transport, authority, requestSignal);
  let id: string | undefined;
  let answer: string | undefined;
  let failure: unknown;
  try {
    check();
    const upload = await uploadAssemblyAudio(valid, bytes, port, check);
    check();
    const created = await createAssemblyTranscript(valid, upload, port, check);
    // Capture only a locally validated ID from this operation's create response.
    id = assemblyTranscriptId(created, valid);
    answer = await completedText(valid, created, id, port, check);
    check();
  } catch (error) {
    failure = error;
  } finally {
    lifetime.abort();
  }
  // No authenticated cleanup after original custody/caller/route withdrawal.
  authority();
  const deletionAcknowledged = await cleanup(valid, id, transport, authority);
  authority();
  if (signal.aborted)
    throw new AssemblyTranscriptInterrupted(deletionAcknowledged);
  if (id && !deletionAcknowledged)
    throw new AiConnectionError(
      "response",
      "Remote transcript removal was not confirmed; no transcript was accepted.",
    );
  if (failure !== undefined) throw failure;
  if (!answer)
    throw new AiConnectionError(
      "response",
      "The transcription did not complete.",
    );
  return { providerId: valid.providerId, model: valid.model, answer };
}
