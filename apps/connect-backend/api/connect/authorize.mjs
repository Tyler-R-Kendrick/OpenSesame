import { handleManage } from "../../manage.mjs";

export default async function handler(req, res) {
  const origin = req.headers.origin ?? "";
  const body =
    req.method === "GET" || req.method === "OPTIONS" ? {} : (req.body ?? {});
  const outcome = await handleManage({
    method: req.method ?? "POST",
    path: "/api/connect/authorize",
    origin,
    body: typeof body === "object" && body !== null ? body : {},
  });
  for (const [key, value] of Object.entries(outcome.headers)) {
    res.setHeader(key, value);
  }
  res.status(outcome.status).send(outcome.body);
}
