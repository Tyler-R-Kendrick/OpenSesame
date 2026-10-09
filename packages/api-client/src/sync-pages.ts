import type { SyncBlob } from "@opensesame/client-core";
import {
  type BoundaryValue,
  isJsonObject,
  isNumber,
  isString,
} from "@opensesame/os-domain";

export type SyncPageCursor = { epoch: number; id: string };
export type SyncPageBlob = {
  id: string;
  epoch: number;
  ciphertext_epoch: number;
  ciphertext_b64: string;
};
export type SyncPage = {
  blobs: SyncPageBlob[];
  next_after: SyncPageCursor | null;
  has_more: boolean;
};
type Request = (path: string, init: RequestInit) => Promise<Response>;

export async function pushSyncBlobs(
  request: Request,
  blobs: SyncBlob[],
): Promise<BoundaryValue> {
  const res = await request("/api/v1/sync/push", {
    method: "POST",
    body: JSON.stringify({
      blobs: blobs.map((b) => ({
        id: b.id,
        epoch: b.epoch,
        ciphertext: Array.from(
          Uint8Array.from(atob(b.ciphertextB64), (c) => c.charCodeAt(0)),
        ),
      })),
    }),
  });
  if (!res.ok) throw new Error(`sync_push_failed:${res.status}`);
  return res.json();
}

async function boundedJson(
  response: Response,
  signal: AbortSignal,
): Promise<BoundaryValue> {
  if (!response.ok || !response.body)
    throw new Error(`sync_pull_failed:${response.status}`);
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let bytes = 0;
  let text = "";
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    signal.throwIfAborted();
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 8 * 1024 * 1024) throw new Error("sync_page_oversize");
      text += decoder.decode(part.value, { stream: true });
    }
    signal.throwIfAborted();
    return JSON.parse(text + decoder.decode());
  } catch {
    throw new Error("invalid_sync_page");
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel();
  }
}

function cursor(value: BoundaryValue): SyncPageCursor | null {
  if (value === null) return null;
  if (
    !isJsonObject(value) ||
    !isNumber(value.epoch) ||
    !Number.isSafeInteger(value.epoch) ||
    value.epoch < 0 ||
    !isString(value.id) ||
    !value.id ||
    value.id.length > 128
  )
    throw new Error("invalid_sync_cursor");
  return { epoch: value.epoch, id: value.id };
}

function parsePage(value: BoundaryValue): SyncPage {
  if (
    !isJsonObject(value) ||
    value.format !== "opensesame-sync-page" ||
    value.version !== 2 ||
    !Array.isArray(value.blobs) ||
    value.blobs.length > 64 ||
    (value.has_more !== true && value.has_more !== false)
  )
    throw new Error("invalid_sync_page");
  const blobs = value.blobs.map(parseBlob);
  return {
    blobs,
    next_after: cursor(value.next_after),
    has_more: value.has_more,
  };
}

function parseBlob(item: BoundaryValue): SyncPageBlob {
  if (
    !isJsonObject(item) ||
    !isString(item.id) ||
    !item.id ||
    item.id.length > 128 ||
    !isNumber(item.epoch) ||
    !Number.isSafeInteger(item.epoch) ||
    item.epoch < 0 ||
    !isNumber(item.ciphertext_epoch) ||
    !Number.isSafeInteger(item.ciphertext_epoch) ||
    item.ciphertext_epoch < 0 ||
    !isString(item.ciphertext_b64) ||
    item.ciphertext_b64.length > 2796204 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
      item.ciphertext_b64,
    )
  )
    throw new Error("invalid_sync_blob");
  return {
    id: item.id,
    epoch: item.epoch,
    ciphertext_epoch: item.ciphertext_epoch,
    ciphertext_b64: item.ciphertext_b64,
  };
}

function follows(next: SyncPageCursor, prior: SyncPageCursor): boolean {
  if (next.epoch !== prior.epoch) return next.epoch > prior.epoch;
  const encoder = new TextEncoder();
  const a = encoder.encode(next.id);
  const b = encoder.encode(prior.id);
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const left = a[i] ?? -1;
    const right = b[i] ?? -1;
    if (left !== right) return left > right;
  }
  return a.length > b.length;
}

function checkContinuation(page: SyncPage, after: SyncPageCursor) {
  const next = page.next_after;
  if (next && !follows(next, after))
    throw new Error("sync_cursor_did_not_advance");
  if (page.has_more && !next) throw new Error("missing_sync_cursor");
  let previous = after;
  for (const blob of page.blobs) {
    if (!follows(blob, previous)) throw new Error("invalid_sync_order");
    previous = blob;
  }
  if (next && (next.epoch !== previous.epoch || next.id !== previous.id))
    throw new Error("invalid_sync_cursor");
}

export async function readSyncPage(
  request: Request,
  after: SyncPageCursor,
  deviceId?: string,
): Promise<SyncPage> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 10000);
  try {
    const page = parsePage(
      await boundedJson(
        await request("/api/v1/sync/pull-page", {
          method: "POST",
          headers: { "content-type": "application/json" },
          signal: controller.signal,
          body: JSON.stringify({ after, device_id: deviceId, limit: 32 }),
        }),
        controller.signal,
      ),
    );
    checkContinuation(page, after);
    return page;
  } finally {
    clearTimeout(timer);
  }
}

/** Process one bounded page at a time; callers need not retain prior ciphertext. */
export async function* pullSyncPages(
  request: Request,
  sinceEpoch = 0,
  deviceId?: string,
) {
  if (
    !Number.isSafeInteger(sinceEpoch) ||
    sinceEpoch < 0 ||
    sinceEpoch >= Number.MAX_SAFE_INTEGER
  )
    throw new Error("invalid_sync_cursor");
  let after: SyncPageCursor = { epoch: sinceEpoch + 1, id: "" };
  for (let pages = 0; pages < 4096; pages++) {
    const page = await readSyncPage(request, after, deviceId);
    const next = page.next_after;
    yield page;
    if (!page.has_more || !next) return;
    after = next;
  }
  throw new Error("sync_page_count_exceeded");
}
