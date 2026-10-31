import type { IncomingMessage, ServerResponse } from "node:http";
import { bodyText, challengeText, html } from "./mock-site-http.js";
import type { Challenge } from "./mock-site.js";

export interface MockSiteState {
  origin: string;
  password: string;
  token: string;
  challenge: Challenge;
  dropSubmit: boolean;
  transformed: boolean;
  drifted: boolean;
  submissions: number;
}

export async function answerMockRequest(
  site: MockSiteState,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const url = new URL(request.url ?? "/", site.origin);
  if (request.method === "GET") return answerGet(site, url, response);
  if (request.method === "POST")
    return answerPost(site, url, request, response);
  response.writeHead(404).end();
}

function answerGet(
  site: MockSiteState,
  url: URL,
  response: ServerResponse,
): void {
  switch (url.pathname) {
    case "/reset":
      html(
        response,
        `<form method="post" action="/request"><label>Email<input name="email" type="email"></label><button>Send reset link</button></form>`,
      );
      return;
    case "/check-email":
      html(
        response,
        "<main>Check your email for a reset link or one-time code</main>",
      );
      return;
    case "/reset/link":
      resetLink(site, url, response);
      return;
    case "/login":
      html(
        response,
        `<form method="post" action="/login"><label>Email<input name="email" type="email"></label><label>Password<input name="password" type="password"></label><button>Sign in</button></form>`,
      );
      return;
    case "/account":
      html(response, "<main>Signed in</main>");
      return;
    default:
      response.writeHead(404).end();
  }
}

function resetLink(
  site: MockSiteState,
  url: URL,
  response: ServerResponse,
): void {
  if (url.searchParams.get("token") !== site.token) {
    response.writeHead(403).end();
    return;
  }
  const saveLabel = site.drifted ? "Save changed" : "Save password";
  html(
    response,
    `${challengeText(site.challenge)}<form method="post" action="/password"><label>New password<input name="password" type="password"></label><button>${saveLabel}</button></form>`,
  );
}

async function answerPost(
  site: MockSiteState,
  url: URL,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  switch (url.pathname) {
    case "/request":
      response.writeHead(303, { location: "/check-email" }).end();
      return;
    case "/challenge/clear":
      site.challenge = null;
      response.writeHead(303, { location: resetUrl(site) }).end();
      return;
    case "/password":
      return password(site, request, response);
    case "/login":
      return login(site, request, response);
    default:
      response.writeHead(404).end();
  }
}

async function password(
  site: MockSiteState,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const body = await bodyText(request);
  const value = new URLSearchParams(body).get("password") ?? "";
  site.submissions += 1;
  site.password = site.transformed ? value.toUpperCase() : value;
  if (site.dropSubmit) {
    site.dropSubmit = false;
    request.socket.destroy();
    return;
  }
  response.writeHead(303, { location: "/login" }).end();
}

async function login(
  site: MockSiteState,
  request: IncomingMessage,
  response: ServerResponse,
): Promise<void> {
  const values = new URLSearchParams(await bodyText(request));
  if (values.get("password") === site.password) {
    response.writeHead(303, { location: "/account" }).end();
  } else response.writeHead(401).end("Not signed in");
}

function resetUrl(site: MockSiteState): string {
  return `${site.origin}/reset/link?token=${site.token}`;
}
