import { handleCallback } from "../../callback.mjs";

export default async function handler(req, res) {
  const proto =
    req.headers["x-forwarded-proto"] ??
    (req.headers.host?.includes("localhost") ? "http" : "https");
  const requestHost = `${proto}://${req.headers.host}`;
  const outcome = handleCallback(req.url ?? "/", requestHost);
  for (const [key, value] of Object.entries(outcome.headers)) {
    res.setHeader(key, value);
  }
  res.status(outcome.status).send(outcome.body);
}
