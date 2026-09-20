import { handleManage } from "../../manage.mjs";

async function run(req, res, path) {
  const origin = req.headers.origin ?? "";
  const body =
    req.method === "GET" || req.method === "OPTIONS" ? {} : (req.body ?? {});
  const outcome = await handleManage({
    method: req.method ?? "GET",
    path,
    origin,
    body: typeof body === "object" && body !== null ? body : {},
  });
  for (const [key, value] of Object.entries(outcome.headers)) {
    res.setHeader(key, value);
  }
  res.status(outcome.status).send(outcome.body);
}

export default async function handler(req, res) {
  await run(req, res, "/api/connect/connectors");
}
