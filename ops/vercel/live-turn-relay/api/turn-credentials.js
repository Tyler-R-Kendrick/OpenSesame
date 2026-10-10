/**
 * TURN REST credential minting stub. Set LIVE_TURN_REST_SECRET and TURN_URLS on
 * the Vercel project, then replace this handler with your TURN provider's REST
 * contract before production use.
 */
export default function handler(request, response) {
  if (request.method !== "GET" && request.method !== "POST") {
    response.status(405).end();
    return;
  }
  const secret = process.env.LIVE_TURN_REST_SECRET;
  const urls = (process.env.TURN_URLS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (!secret || urls.length === 0) {
    response.status(503).json({
      error: "not_configured",
      message: "Set LIVE_TURN_REST_SECRET and TURN_URLS on the Vercel project.",
    });
    return;
  }
  response.status(501).json({
    error: "not_implemented",
    message:
      "Wire this route to your TURN REST provider; see ops/vercel/live-turn-relay/README.md.",
    urls,
  });
}
