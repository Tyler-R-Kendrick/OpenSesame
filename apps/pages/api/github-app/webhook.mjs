import { handleGithubAppWebhook } from "../../server/github-app-contents.mjs";
import { isPayloadTooLarge, readRawBody } from "../../server/read-body.mjs";

export const config = {
  api: {
    bodyParser: false,
  },
};

function sendBodyTooLarge(res) {
  res.status(413).send("body_too_large");
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).send("POST only.");
    return;
  }
  let rawBody = "";
  try {
    rawBody = await readRawBody(req);
  } catch (error) {
    if (isPayloadTooLarge(error)) {
      sendBodyTooLarge(res);
      return;
    }
    throw error;
  }
  let body = {};
  try {
    body = rawBody ? JSON.parse(rawBody) : {};
  } catch {
    body = {};
  }
  const outcome = await handleGithubAppWebhook(body, req.headers, rawBody);
  for (const [key, value] of Object.entries(outcome.headers)) {
    res.setHeader(key, value);
  }
  res.status(outcome.status).send(outcome.body);
}
