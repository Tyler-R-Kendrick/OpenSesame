/**
 * Buffered replay of a raw request (the `/token` exact-origin CORS gate must
 * read the form body before oidc-provider does). The replayed request keeps
 * the original socket AND the evidence recorded for the original request —
 * copied by object, never re-derived from the bytes being replayed — so the
 * `/token` replay cannot lose or change its peer (AT-IDENTITY-SPLIT).
 */
import type http from "node:http";
import { Readable } from "node:stream";
import { overlapCast } from "@opensesame/os-domain";
import { adoptRequestEvidence } from "./request-evidence.js";

export async function readBody(req: http.IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    if (!(chunk instanceof Uint8Array)) {
      throw new TypeError("HTTP request body yielded a non-byte chunk");
    }
    chunks.push(Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}

/**
 * The CORS gate must read the form body to learn the client_id, so the
 * request stream handed to oidc-provider is replayed from the buffer.
 */
export function replayRequest(
  req: http.IncomingMessage,
  body: Buffer,
): http.IncomingMessage {
  // SAFETY: oidc-provider only reads this as a stream plus IncomingMessage
  // header/method fields, which we copy onto the replayed Readable below.
  const forwarded: http.IncomingMessage = overlapCast(Readable.from([body]));
  forwarded.headers = req.headers;
  forwarded.rawHeaders = req.rawHeaders;
  forwarded.method = req.method;
  forwarded.url = req.url;
  forwarded.httpVersion = req.httpVersion;
  forwarded.httpVersionMajor = req.httpVersionMajor;
  forwarded.httpVersionMinor = req.httpVersionMinor;
  forwarded.socket = req.socket;
  adoptRequestEvidence(forwarded, req);
  return forwarded;
}
