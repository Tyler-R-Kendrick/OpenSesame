import {
  handleGithubAppConvertOptions,
  handleGithubAppInstallations,
} from "../../src/github-app.mjs";

export default async function handler(req, res) {
  const origin = req.headers.origin ?? "";
  if (req.method === "OPTIONS") {
    const outcome = handleGithubAppConvertOptions(origin);
    for (const [key, value] of Object.entries(outcome.headers)) {
      res.setHeader(key, value);
    }
    res.status(outcome.status).send(outcome.body);
    return;
  }
  if (req.method !== "POST") {
    res.status(405).send("POST only.");
    return;
  }
  const body =
    typeof req.body === "object" && req.body !== null ? req.body : {};
  const outcome = await handleGithubAppInstallations(body, origin);
  for (const [key, value] of Object.entries(outcome.headers)) {
    res.setHeader(key, value);
  }
  res.status(outcome.status).send(outcome.body);
}
