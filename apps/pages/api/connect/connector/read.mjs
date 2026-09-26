import { handleManage, manageInput } from "../../../server/manage.mjs";

export default async function handler(req, res) {
  const outcome = await handleManage(
    manageInput(req, "/api/connect/connector/read"),
  );
  for (const [key, value] of Object.entries(outcome.headers)) {
    res.setHeader(key, value);
  }
  res.status(outcome.status).send(outcome.body);
}
