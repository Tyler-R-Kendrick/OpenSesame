import { handleManage, manageInput } from "../../src/manage.mjs";

export default async function handler(req, res) {
  const outcome = await handleManage(
    manageInput(req, "/api/connect/authorize"),
  );
  for (const [key, value] of Object.entries(outcome.headers)) {
    res.setHeader(key, value);
  }
  res.status(outcome.status).send(outcome.body);
}
