import { randomUUID } from "node:crypto";
import { type Server, createServer } from "node:http";
import { answerMockRequest } from "./mock-site-routes.js";

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
    return answerMockRequest(this, request, response);
  }
}
