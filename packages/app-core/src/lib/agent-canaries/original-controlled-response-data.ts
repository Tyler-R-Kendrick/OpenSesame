/** Owned native response DATA only. No reader or copied response creates an owner verdict. */
import type { BoundaryValue } from "@opensesame/os-domain";
import { assertUnambiguousJson } from "../retired-credentials/json-preflight.js";
const bindOriginal = Function.prototype.call.bind(Function.prototype.bind);
const callOriginal = Function.prototype.call.bind(Function.prototype.call);
const originalFill = Uint8Array.prototype.fill;
const originalBytes = Uint8Array;
const originalSet = originalBytes.prototype.set;
const fillBytes: (
  method: typeof originalFill,
  receiver: Uint8Array,
  value: number,
) => Uint8Array = callOriginal;
const setBytes: (
  method: typeof originalSet,
  receiver: Uint8Array,
  source: ArrayLike<number>,
  offset: number,
) => void = callOriginal;
const originalByteLength =
  Object.getOwnPropertyDescriptor(
    Object.getPrototypeOf(originalBytes.prototype),
    "byteLength",
  )?.get ?? unavailable();
const readByteLength: (value: Uint8Array) => number =
  Function.prototype.call.bind(originalByteLength);
const RESPONSE_BYTES = 256 << 10;
type Reader = ReadableStreamDefaultReader<Uint8Array>;
type OriginalResponseWork = Readonly<{
  response: Response;
  original: () => void;
  abort: () => void;
}>;
type OriginalResponseOwner = {
  reader?: Reader;
  stream?: ReadableStream<Uint8Array>;
  getReader?: ReadableStream<Uint8Array>["getReader"];
  rawRead?: Reader["read"];
  rawCancel?: Reader["cancel"];
  rawRelease?: Reader["releaseLock"];
  read?: Reader["read"];
  cancel?: () => Promise<void>;
  release?: () => void;
  readonly chunks: Uint8Array[];
  readonly failures: unknown[];
  assembled?: Uint8Array;
  size: number;
  finished: boolean;
};
function unavailable(): never {
  throw new Error("Controlled canary receiver unavailable.");
}
function refuse<T>(failures: readonly T[]): void {
  if (failures.length === 1) throw failures[0];
  if (failures.length)
    throw new AggregateError(
      failures,
      "Original controlled response and drain failed.",
    );
}
function captureReader(
  input: OriginalResponseWork,
  owned: OriginalResponseOwner,
) {
  input.original();
  const stream = input.response.body;
  if (!stream) unavailable();
  owned.stream = stream;
  const getReader = stream.getReader;
  owned.getReader = getReader;
  const acquire: () => Reader = bindOriginal(getReader, stream);
  owned.reader = acquire();
  const reader = owned.reader;
  const failures: unknown[] = [];
  // Each delivered disposal slot is retained before read and independently attempted on refusal.
  try {
    owned.rawRelease = reader.releaseLock;
    owned.release = bindOriginal(owned.rawRelease, reader);
  } catch (cause) {
    failures.push(cause);
  }
  try {
    owned.rawCancel = reader.cancel;
    owned.cancel = bindOriginal(owned.rawCancel, reader);
  } catch (cause) {
    failures.push(cause);
  }
  try {
    owned.rawRead = reader.read;
    owned.read = bindOriginal(owned.rawRead, reader);
  } catch (cause) {
    failures.push(cause);
  }
  refuse(failures);
}
function originalReader(
  input: OriginalResponseWork,
  owned: OriginalResponseOwner,
) {
  input.original();
  const reader = owned.reader;
  if (
    !reader ||
    !owned.stream ||
    input.response.body !== owned.stream ||
    owned.stream.getReader !== owned.getReader ||
    reader.read !== owned.rawRead ||
    reader.cancel !== owned.rawCancel ||
    reader.releaseLock !== owned.rawRelease
  )
    unavailable();
  input.original();
}
function retainChunk(
  input: OriginalResponseWork,
  owned: OriginalResponseOwner,
  next: ReadableStreamReadResult<Uint8Array>,
) {
  const failures: unknown[] = [];
  try {
    originalReader(input, owned);
    if (next.done) owned.finished = true;
    else {
      owned.size += readByteLength(next.value);
      if (owned.size > RESPONSE_BYTES) unavailable();
      owned.chunks.push(new originalBytes(next.value));
    }
  } catch (cause) {
    failures.push(cause);
  }
  try {
    if (!next.done) fillBytes(originalFill, next.value, 0);
  } catch (cause) {
    failures.push(cause);
  }
  refuse(failures);
}
async function readResponse(
  input: OriginalResponseWork,
  owned: OriginalResponseOwner,
): Promise<BoundaryValue> {
  captureReader(input, owned);
  originalReader(input, owned);
  if (
    !input.response.ok ||
    !input.response.headers.get("content-type")?.startsWith("application/json")
  )
    unavailable();
  const read = owned.read;
  if (!read) unavailable();
  while (!owned.finished) {
    originalReader(input, owned);
    retainChunk(input, owned, await read());
  }
  const bytes = new originalBytes(owned.size);
  owned.assembled = bytes;
  let at = 0;
  for (const chunk of owned.chunks) {
    setBytes(originalSet, bytes, chunk, at);
    at += readByteLength(chunk);
  }
  const wire = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  assertUnambiguousJson(wire, RESPONSE_BYTES);
  originalReader(input, owned);
  return JSON.parse(wire);
}
function wipeOriginalResponseBytes(owned: OriginalResponseOwner) {
  if (owned.assembled) {
    try {
      fillBytes(originalFill, owned.assembled, 0);
    } catch (cause) {
      owned.failures.push(cause);
    }
  }
  for (const chunk of owned.chunks) {
    try {
      fillBytes(originalFill, chunk, 0);
    } catch (cause) {
      owned.failures.push(cause);
    }
  }
}
export async function readOriginalControlledResponseData(
  input: OriginalResponseWork,
): Promise<BoundaryValue> {
  const owned: OriginalResponseOwner = {
    chunks: [],
    failures: [],
    size: 0,
    finished: false,
  };
  const failures = owned.failures;
  let result: BoundaryValue | undefined;
  try {
    result = await readResponse(input, owned);
  } catch (cause) {
    failures.push(cause);
  }
  wipeOriginalResponseBytes(owned);
  if (!owned.finished) {
    try {
      input.abort();
    } catch (cause) {
      failures.push(cause);
    }
    try {
      const cancel =
        owned.cancel ??
        (owned.reader
          ? bindOriginal(owned.reader.cancel, owned.reader)
          : undefined);
      await cancel?.();
    } catch (cause) {
      failures.push(cause);
    }
  }
  try {
    const release =
      owned.release ??
      (owned.reader
        ? bindOriginal(owned.reader.releaseLock, owned.reader)
        : undefined);
    release?.();
  } catch (cause) {
    failures.push(cause);
  }
  refuse(failures);
  if (result === undefined) unavailable();
  return result;
}
