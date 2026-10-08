/**
 * One ceiling for every inbound relay body. Outbound forge reads already stop
 * at 5 MiB (`pinned-fetch.mjs`); a request that crosses the same line is
 * dropped before JSON parsing or any secret, manage-key, or origin check.
 */

export const MAX_INBOUND_BODY_BYTES = 5 * 1024 * 1024;

export class PayloadTooLargeError extends Error {
  constructor() {
    super("body_too_large");
    this.name = "PayloadTooLargeError";
    this.statusCode = 413;
  }
}

export function isPayloadTooLarge(error) {
  return error instanceof PayloadTooLargeError;
}

function asBuffer(chunk) {
  return typeof chunk === "string" ? Buffer.from(chunk) : chunk;
}

function withinCeiling(raw) {
  if (Buffer.byteLength(raw) > MAX_INBOUND_BODY_BYTES) {
    throw new PayloadTooLargeError();
  }
  return raw;
}

function readEvents(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    let failed = false;
    const fail = (error) => {
      if (failed) return;
      failed = true;
      chunks.length = 0;
      if (typeof req.destroy === "function") req.destroy();
      reject(error);
    };
    req.on("data", (chunk) => {
      if (failed) return;
      const buf = asBuffer(chunk);
      size += buf.length;
      if (size > MAX_INBOUND_BODY_BYTES) {
        fail(new PayloadTooLargeError());
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => {
      if (!failed) resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (!failed) reject(error);
    });
  });
}

async function readAsync(req) {
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of req) {
      const buf = asBuffer(chunk);
      size += buf.length;
      if (size > MAX_INBOUND_BODY_BYTES) {
        chunks.length = 0;
        if (typeof req.destroy === "function") req.destroy();
        throw new PayloadTooLargeError();
      }
      chunks.push(buf);
    }
  } catch (error) {
    chunks.length = 0;
    throw error;
  }
  return Buffer.concat(chunks).toString("utf8");
}

/** Read a UTF-8 body, or reject with {@link PayloadTooLargeError}. */
export function readRawBody(req) {
  if (typeof req.body === "string") {
    return Promise.resolve().then(() => withinCeiling(req.body));
  }
  if (Buffer.isBuffer(req.body)) {
    return Promise.resolve().then(() =>
      withinCeiling(req.body.toString("utf8")),
    );
  }
  if (req && typeof req.on === "function") return readEvents(req);
  if (req && typeof req[Symbol.asyncIterator] === "function") {
    return readAsync(req);
  }
  return Promise.resolve("");
}
