import type { IncomingMessage, ServerResponse } from "node:http";
import type { Challenge } from "./mock-site.js";

export function html(response: ServerResponse, body: string): void {
  response
    .writeHead(200, { "content-type": "text/html; charset=utf-8" })
    .end(`<!doctype html><html><body>${body}</body></html>`);
}

export function challengeText(challenge: Challenge): string {
  if (!challenge) return "";
  const text =
    challenge === "captcha"
      ? "CAPTCHA verify you are human"
      : challenge === "mail_code"
        ? "One-time code from email"
        : challenge === "totp"
          ? "Authenticator TOTP code required"
          : "Passkey security key required";
  return `<p>${text}</p><form method="post" action="/challenge/clear"><button>Challenge completed</button></form>`;
}

export async function bodyText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
