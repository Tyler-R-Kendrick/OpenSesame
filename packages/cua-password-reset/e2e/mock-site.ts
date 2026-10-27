import { createServer, type Server } from "node:http";
import { randomUUID } from "node:crypto";

export type Challenge = "captcha" | "mail_code" | "totp" | "passkey" | null;

export class MockResetSite {
  private server: Server | undefined;
  private password = "old-password";
  private token = randomUUID();
  private challenge: Challenge = null;
  private dropSubmit = false;
  private transformed = false;
  private drifted = false;
  origin = "";
  submissions = 0;

  async start(): Promise<void> {
    this.server = createServer((request, response) => {
      void this.answer(request, response);
    });
    await new Promise<void>((resolve) => this.server?.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    if (!address || typeof address === "string") throw new Error("Mock site did not bind");
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  resetLink(): string {
    return `${this.origin}/reset/link?token=${this.token}`;
  }

  setChallenge(challenge: Challenge): void {
    this.challenge = challenge;
  }

  dropNextPasswordResponse(): void {
    this.dropSubmit = true;
  }

  transformPasswords(): void {
    this.transformed = true;
  }

  driftForm(): void {
    this.drifted = true;
  }

  accepts(password: string): boolean {
    return this.password === password;
  }

  restorePassword(): void {
    this.password = "old-password";
  }

  private async answer(
    request: import("node:http").IncomingMessage,
    response: import("node:http").ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", this.origin);
    if (request.method === "GET" && url.pathname === "/reset") {
      html(response, `<form method="post" action="/request"><label>Email<input name="email" type="email"></label><button>Send reset link</button></form>`);
      return;
    }
    if (request.method === "POST" && url.pathname === "/request") {
      response.writeHead(303, { location: "/check-email" }).end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/check-email") {
      html(response, "<main>Check your email for a reset link or one-time code</main>");
      return;
    }
    if (request.method === "GET" && url.pathname === "/reset/link") {
      if (url.searchParams.get("token") !== this.token) {
        response.writeHead(403).end();
        return;
      }
      const saveLabel = this.drifted ? "Save changed" : "Save password";
      html(response, `${challengeText(this.challenge)}<form method="post" action="/password"><label>New password<input name="password" type="password"></label><button>${saveLabel}</button></form>`);
      return;
    }
    if (request.method === "POST" && url.pathname === "/challenge/clear") {
      this.challenge = null;
      response.writeHead(303, { location: this.resetLink() }).end();
      return;
    }
    if (request.method === "POST" && url.pathname === "/password") {
      const body = await bodyText(request);
      const password = new URLSearchParams(body).get("password") ?? "";
      this.submissions += 1;
      this.password = this.transformed ? password.toUpperCase() : password;
      if (this.dropSubmit) {
        this.dropSubmit = false;
        request.socket.destroy();
        return;
      }
      response.writeHead(303, { location: "/login" }).end();
      return;
    }
    if (request.method === "GET" && url.pathname === "/login") {
      html(response, `<form method="post" action="/login"><label>Email<input name="email" type="email"></label><label>Password<input name="password" type="password"></label><button>Sign in</button></form>`);
      return;
    }
    if (request.method === "POST" && url.pathname === "/login") {
      const values = new URLSearchParams(await bodyText(request));
      if (values.get("password") === this.password) {
        response.writeHead(303, { location: "/account" }).end();
      } else response.writeHead(401).end("Not signed in");
      return;
    }
    if (request.method === "GET" && url.pathname === "/account") {
      html(response, "<main>Signed in</main>");
      return;
    }
    response.writeHead(404).end();
  }
}

function challengeText(challenge: Challenge): string {
  if (!challenge) return "";
  const text = challenge === "captcha" ? "CAPTCHA verify you are human"
    : challenge === "mail_code" ? "One-time code from email"
      : challenge === "totp" ? "Authenticator TOTP code required"
        : "Passkey security key required";
  return `<p>${text}</p><form method="post" action="/challenge/clear"><button>Challenge completed</button></form>`;
}

function html(response: import("node:http").ServerResponse, body: string): void {
  response.writeHead(200, { "content-type": "text/html; charset=utf-8" }).end(
    `<!doctype html><html><body>${body}</body></html>`,
  );
}

async function bodyText(request: import("node:http").IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}
