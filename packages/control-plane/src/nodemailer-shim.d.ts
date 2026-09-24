/**
 * Minimal ambient types for nodemailer (no bundled `.d.ts`).
 *
 * Only the surface OpenSesame uses is declared, the same way
 * `packages/oauth-provider` declares oidc-provider. Written against the
 * installed nodemailer 9.0.5 sources (`lib/nodemailer.js`,
 * `lib/json-transport/index.js`), not from memory.
 */
declare module "nodemailer" {
  export interface MailMessage {
    from?: string;
    to?: string;
    subject?: string;
    text?: string;
    html?: string;
  }

  /**
   * `jsonTransport` sets `message` to the composed message as JSON; SMTP does
   * not set it at all. `envelope`/`messageId` come from the same MailComposer
   * pass in both transports.
   */
  export interface SentMessageInfo {
    messageId?: string;
    envelope?: { from: string | false; to: string[] };
    message?: string;
  }

  export interface Transporter {
    sendMail(message: MailMessage): Promise<SentMessageInfo>;
    close(): void;
  }

  export type TransportConfig =
    | { jsonTransport: true }
    | {
        url: string;
        pool?: boolean;
        auth?: { user: string; pass: string };
      };

  export function createTransport(config: TransportConfig): Transporter;
}
