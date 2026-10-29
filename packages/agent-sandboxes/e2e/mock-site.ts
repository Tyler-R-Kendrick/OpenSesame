/**
 * Minimal server-rendered reset site for sandbox-provider e2e. Same shape
 * as the CUA mock (plain forms, token link, optional CAPTCHA gate) so all
 * four provider lanes drive identical ceremonies.
 */
import { randomUUID } from "node:crypto";
import {
  type IncomingMessage,
  type Server,
  type ServerResponse,
  createServer,
} from "node:http";

function page(response: ServerResponse, body: string): void {
  response
    .writeHead(200, { "content-type": "text/html; charset=utf-8" })
    .end(`<!doctype html><html><body>${body}</body></html>`);
}

async function bodyText(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export class MockResetSite {
  private server: Server | undefined;
  private password = "old-password";
  private readonly token = randomUUID();
  private challengePending = false;
  origin = "";
  submissions = 0;

  async start(withChallenge = false): Promise<void> {
    this.challengePending = withChallenge;
    this.server = createServer((request, response) => {
      void this.answer(request, response);
    });
    await new Promise<void>((resolve) =>
      this.server?.listen(0, "127.0.0.1", resolve),
    );
    const address = this.server.address();
    if (!address || !(address instanceof Object) || !("port" in address))
      throw new Error("Mock site did not bind");
    this.origin = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (server)
      await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  resetLink(): string {
    return `${this.origin}/reset/link?token=${this.token}`;
  }

  accepts(password: string): boolean {
    return this.password === password;
  }

  restorePassword(): void {
    this.password = "old-password";
  }

  private async answer(
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const url = new URL(request.url ?? "/", this.origin);
    if (request.method === "GET") return this.answerGet(url, response);
    if (request.method === "POST")
      return this.answerPost(url, request, response);
    response.writeHead(404).end();
  }

  private answerGet(url: URL, response: ServerResponse): void {
    switch (url.pathname) {
      case "/reset":
        page(
          response,
          `<form method="post" action="/request"><label>Email<input name="email" type="email"></label><button>Send reset link</button></form>`,
        );
        return;
      case "/check-email":
        page(response, "<main>Check your email for a reset link</main>");
        return;
      case "/reset/link": {
        if (url.searchParams.get("token") !== this.token) {
          page(response, "<main>Reset link expired</main>");
          return;
        }
        const challenge = this.challengePending
          ? `<p>CAPTCHA verify you are human</p><form method="post" action="/challenge/clear"><button>Challenge completed</button></form>`
          : "";
        page(
          response,
          `${challenge}<form method="post" action="/password"><input type="hidden" name="token" value="${this.token}"><label>New password<input name="password" type="password"></label><button>Save password</button></form>`,
        );
        return;
      }
      case "/login":
        page(
          response,
          `<form method="post" action="/login"><label>Email<input name="email" type="email"></label><label>Password<input name="password" type="password"></label><button>Sign in</button></form>`,
        );
        return;
      case "/account":
        page(response, "<main>Signed in</main>");
        return;
      default:
        response.writeHead(404).end();
    }
  }

  private async answerPost(
    url: URL,
    request: IncomingMessage,
    response: ServerResponse,
  ): Promise<void> {
    const values = new URLSearchParams(await bodyText(request));
    switch (url.pathname) {
      case "/request":
        response.writeHead(303, { location: "/check-email" }).end();
        return;
      case "/challenge/clear":
        this.challengePending = false;
        response
          .writeHead(303, {
            location: `/reset/link?token=${this.token}`,
          })
          .end();
        return;
      case "/password": {
        const next = values.get("password");
        if (values.get("token") !== this.token || !next) {
          page(response, "<main>Password was not updated</main>");
          return;
        }
        this.password = next;
        this.submissions += 1;
        page(response, "<main>Password updated</main>");
        return;
      }
      case "/login":
        if (
          values.get("email") === "person@example.test" &&
          values.get("password") === this.password
        ) {
          response.writeHead(303, { location: "/account" }).end();
          return;
        }
        page(response, "<main>Sign in failed</main>");
        return;
      default:
        response.writeHead(404).end();
    }
  }
}
