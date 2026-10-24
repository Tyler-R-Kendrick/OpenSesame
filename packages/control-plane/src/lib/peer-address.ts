import type { HttpBindings } from "@hono/node-server";
import type { Context } from "hono";
import type { Variables } from "../middleware/context.js";

/**
 * The TCP peer behind a request, when the Node server adapter answered it.
 * An in-process `app.request()` has no socket, so callers fall back.
 */
export function peerAddress(
  c: Context<{ Variables: Variables }>,
): string | undefined {
  // SAFETY: the @hono/node-server adapter's contract makes `c.env` its HttpBindings; an in-process request leaves it undefined, so every step is checked by the optional chain.
  const env = c.env as HttpBindings | undefined;
  return env?.incoming?.socket?.remoteAddress;
}
