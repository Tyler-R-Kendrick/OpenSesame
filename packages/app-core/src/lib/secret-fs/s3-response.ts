/** One owned fetch/body lifetime. No live native Response escapes this helper. */
export type S3Reply = Readonly<{
  status: number;
  ok: boolean;
  etag: string | null;
  bytes: Uint8Array;
}>;

type Exchange = Readonly<{
  send: typeof fetch;
  url: string;
  init: RequestInit;
  signal: AbortSignal;
  owner: AbortSignal | undefined;
  check: () => void;
  max: number;
  retain: boolean;
}>;

function checkCurrent(options: Exchange, signal: AbortSignal): void {
  if (signal.aborted || options.owner?.aborted)
    throw new Error("bucket operation ended");
  options.check();
  if (signal.aborted || options.owner?.aborted)
    throw new Error("bucket operation ended");
}

function declaredFits(response: Response, max: number): void {
  const encoding = response.headers.get("content-encoding");
  if (encoding !== null && encoding !== "identity") return;
  const raw = response.headers.get("content-length");
  if (raw === null || !/^\d+$/.test(raw)) return;
  const length = Number(raw);
  if (length > max) throw new RangeError("bucket answer exceeds its bound");
}

async function consume(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  max: number,
  retain: boolean,
  check: () => void,
  eof: () => void,
) {
  const buffer = new Uint8Array(retain ? max : 0);
  let total = 0;
  while (true) {
    check();
    const part = await reader.read();
    if (part.done) eof();
    check();
    if (part.done) return buffer.slice(0, total);
    if (part.value.byteLength > max - total) {
      throw new RangeError("bucket answer exceeds its bound");
    }
    if (retain) buffer.set(part.value, total);
    total += part.value.byteLength;
  }
}

/** Abort active I/O on error; completed EOF never aborts the local controller. */
export async function s3Exchange(options: Exchange): Promise<S3Reply> {
  const local = new AbortController();
  const signal = AbortSignal.any([
    options.signal,
    local.signal,
    ...(options.owner ? [options.owner] : []),
  ]);
  const check = () => checkCurrent(options, signal);
  let response: Response | undefined;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let eof = false;
  let cancellation: Promise<void> | undefined;
  const cancel = () => {
    cancellation ??= Promise.resolve()
      .then(() => (reader ? reader.cancel() : response?.body?.cancel()))
      .then(
        () => undefined,
        () => undefined,
      );
    return cancellation;
  };
  let bytes = new Uint8Array();
  try {
    check();
    response = await options.send(options.url, { ...options.init, signal });
    check();
    if (response.ok) {
      const max = options.retain ? options.max : 4096;
      declaredFits(response, max);
      if (response.body === null) eof = true;
      else {
        reader = response.body.getReader();
        signal.addEventListener("abort", cancel, { once: true });
        check();
        bytes = await consume(reader, max, options.retain, check, () => {
          eof = true;
        });
      }
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    if (!eof) {
      local.abort();
      await cancel();
    }
    reader?.releaseLock();
  }
  checkCurrent(options, options.signal);
  if (response === undefined) throw new Error("bucket answer missing");
  return {
    status: response.status,
    ok: response.ok,
    etag: response.headers.get("etag"),
    bytes,
  };
}
