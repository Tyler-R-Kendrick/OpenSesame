import { createTransport } from "nodemailer";
import type { ControlPlaneConfig } from "../config.js";

/**
 * Outbound email (D16).
 *
 * The identity plane sends exactly one kind of message today — an email
 * magic-link — and it goes through nodemailer's real SMTP transport wherever
 * SMTP is configured. Locally and in tests the transport is nodemailer's
 * `jsonTransport`, which is a real transport: it runs the same MailComposer
 * pass SMTP runs and hands back the fully composed message instead of opening
 * a socket. That is what makes an assertion about "the email we sent" an
 * assertion about a message nodemailer actually built, rather than about a
 * string a test double was handed.
 */

export interface OutboundMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

/**
 * One composed message, as nodemailer handed it back.
 *
 * `body` is `info.message` verbatim — under `jsonTransport` that is the
 * composed message serialized as JSON (headers, envelope, subject, parts).
 * Under SMTP nodemailer sets no `message`, so the outbox stays empty: nothing
 * is captured for messages that really went out over the wire.
 */
export interface CapturedMail {
  messageId: string;
  envelope: { from: string | false; to: string[] };
  body: string;
}

export class MailerNotConfiguredError extends Error {
  override readonly name = "MailerNotConfiguredError";

  constructor() {
    super("No mail transport is configured (set OPENSESAME_SMTP_URL)");
  }
}

export interface Mailer {
  send(mail: OutboundMail): Promise<void>;
  /** Composed messages captured by the local transport, newest last. */
  readonly outbox: readonly CapturedMail[];
}

/**
 * A composed message is a few kilobytes and the outbox exists for local
 * inspection, not retention; the cap keeps a long-running dev process from
 * holding every link it ever issued.
 */
const MAX_CAPTURED = 50;

function defaultFrom(config: ControlPlaneConfig): string {
  let host = "localhost";
  try {
    host = new URL(config.publicUrl).hostname;
  } catch {
    // publicUrl is validated elsewhere; a bad value must not take mail with it.
  }
  return `OpenSesame <no-reply@${host}>`;
}

/**
 * Build the deployment's mailer.
 *
 * Reads its own environment rather than `ControlPlaneConfig` because the config
 * module belongs to another swarm this cycle; the variables are the env-spec
 * ones documented in `.env.schema` (`OPENSESAME_SMTP_URL` is `@sensitive` — it
 * carries SMTP credentials — and `OPENSESAME_MAIL_FROM` is `@public`).
 */
export function createMailer(
  env: NodeJS.ProcessEnv,
  config: ControlPlaneConfig,
): Mailer {
  const smtpUrl = env.OPENSESAME_SMTP_URL?.trim();
  const from = env.OPENSESAME_MAIL_FROM?.trim() || defaultFrom(config);
  const captured: CapturedMail[] = [];

  if (!smtpUrl && !config.allowDevDefaults) {
    // No transport and no local shortcut: refuse loudly at send time rather
    // than silently dropping a sign-in link on the floor.
    return {
      outbox: captured,
      async send() {
        throw new MailerNotConfiguredError();
      },
    };
  }

  const transport = smtpUrl
    ? createTransport({ url: smtpUrl })
    : createTransport({ jsonTransport: true });

  return {
    outbox: captured,
    async send(mail) {
      const info = await transport.sendMail({
        from,
        to: mail.to,
        subject: mail.subject,
        text: mail.text,
        ...(mail.html !== undefined ? { html: mail.html } : undefined),
      });
      if (info.message === undefined) return;
      captured.push({
        messageId: info.messageId ?? "",
        envelope: info.envelope ?? { from, to: [mail.to] },
        body: info.message,
      });
      if (captured.length > MAX_CAPTURED) captured.splice(0, 1);
    },
  };
}
