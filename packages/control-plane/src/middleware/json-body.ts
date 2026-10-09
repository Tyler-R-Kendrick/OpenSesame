import type { Context } from "hono";
import type { Variables } from "./context.js";

/**
 * A request body that is not JSON is the client's mistake, not the server's.
 *
 * Handlers read their body with `c.req.json()`, which throws the parser's
 * `SyntaxError` on malformed input. Left to `onError`, that became a logged
 * "request failed" and a 500 `internal_error`.
 *
 * When `json()` throws, Hono has already cached the text it tried to parse.
 * If the failure is a `SyntaxError` and that cached text does not parse, the
 * body was the problem, and the answer is a 400. Nothing is read here that a
 * handler did not read first: a route that hands the raw request on (Better
 * Auth reads `c.req.raw` itself) still gets its stream untouched.
 */
export async function malformedJsonResponse(
  err: Error,
  c: Context<{ Variables: Variables }>,
): Promise<Response | null> {
  const cached = c.req.bodyCache.text;
  if (!(err instanceof SyntaxError) || cached === undefined) return null;
  try {
    JSON.parse(await cached);
    return null;
  } catch {
    return c.json(
      {
        error: "invalid_json",
        message: "The request body is not valid JSON.",
        correlationId: c.get("correlationId"),
      },
      400,
    );
  }
}
