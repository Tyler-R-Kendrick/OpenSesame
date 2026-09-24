import {
  type BoundaryValue,
  isJsonObject,
  isString,
} from "@opensesame/os-domain";
import { createTransport } from "nodemailer";
import type { ControlPlaneConfig } from "../config.js";

/**
 * Outbound email (D16 + MFA codes).
 *
 * Prefer an HTTP ESP when its key is set (Resend, SendGrid, Postmark, Brevo —
 * the same providers Pages binds under `mfa_email`), then SMTP via
 * `OPENSESAME_SMTP_URL`. Locally and in tests without either, nodemailer's
 * `jsonTransport` captures composed messages when dev defaults are allowed.
 */

export interface OutboundMail {
  to: string;
  subject: string;
  text: string;
  html?: string;
}

export interface CapturedMail {
  messageId: string;
  envelope: { from: string | false; to: string[] };
  body: string;
}

export class MailerNotConfiguredError extends Error {
  override readonly name = "MailerNotConfiguredError";

  constructor() {
    super(
      "No mail transport is configured (set OPENSESAME_RESEND_API_KEY, another ESP key, or OPENSESAME_SMTP_URL)",
    );
  }
}

export interface Mailer {
  send(mail: OutboundMail): Promise<void>;
  readonly outbox: readonly CapturedMail[];
}

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

function addressFromMailbox(from: string): string {
  const angled = from.match(/<([^>]+)>/);
  return angled?.[1]?.trim() || from.trim();
}

type HttpEsp = {
  id: string;
  send: (mail: OutboundMail, from: string) => Promise<{ id: string }>;
};

async function readJson(res: Response): Promise<BoundaryValue> {
  return res.json().catch(() => null);
}

function pickHttpEsp(env: NodeJS.ProcessEnv): HttpEsp | undefined {
  const resend = env.OPENSESAME_RESEND_API_KEY?.trim();
  if (resend) {
    return {
      id: "resend",
      async send(mail, from) {
        const body =
          mail.html !== undefined
            ? {
                from,
                to: [mail.to],
                subject: mail.subject,
                text: mail.text,
                html: mail.html,
              }
            : {
                from,
                to: [mail.to],
                subject: mail.subject,
                text: mail.text,
              };
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${resend}`,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(`resend_send_failed:${res.status}:${detail}`);
        }
        const payload = await readJson(res);
        const id =
          isJsonObject(payload) && isString(payload.id) ? payload.id : "";
        return { id };
      },
    };
  }

  const sendgrid = env.OPENSESAME_SENDGRID_API_KEY?.trim();
  if (sendgrid) {
    return {
      id: "sendgrid",
      async send(mail, from) {
        const content =
          mail.html !== undefined
            ? [
                { type: "text/plain", value: mail.text },
                { type: "text/html", value: mail.html },
              ]
            : [{ type: "text/plain", value: mail.text }];
        const res = await fetch("https://api.sendgrid.com/v3/mail/send", {
          method: "POST",
          headers: {
            authorization: `Bearer ${sendgrid}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: mail.to }] }],
            from: { email: addressFromMailbox(from) },
            subject: mail.subject,
            content,
          }),
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok && res.status !== 202) {
          const detail = await res.text().catch(() => "");
          throw new Error(`sendgrid_send_failed:${res.status}:${detail}`);
        }
        return { id: res.headers.get("x-message-id") ?? "" };
      },
    };
  }

  const postmark = env.OPENSESAME_POSTMARK_SERVER_TOKEN?.trim();
  if (postmark) {
    return {
      id: "postmark",
      async send(mail, from) {
        const body =
          mail.html !== undefined
            ? {
                From: from,
                To: mail.to,
                Subject: mail.subject,
                TextBody: mail.text,
                HtmlBody: mail.html,
              }
            : {
                From: from,
                To: mail.to,
                Subject: mail.subject,
                TextBody: mail.text,
              };
        const res = await fetch("https://api.postmarkapp.com/email", {
          method: "POST",
          headers: {
            "X-Postmark-Server-Token": postmark,
            "content-type": "application/json",
            accept: "application/json",
          },
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(`postmark_send_failed:${res.status}:${detail}`);
        }
        const payload = await readJson(res);
        const id =
          isJsonObject(payload) && isString(payload.MessageID)
            ? payload.MessageID
            : "";
        return { id };
      },
    };
  }

  const brevo = env.OPENSESAME_BREVO_API_KEY?.trim();
  if (brevo) {
    return {
      id: "brevo",
      async send(mail, from) {
        const body =
          mail.html !== undefined
            ? {
                sender: { email: addressFromMailbox(from) },
                to: [{ email: mail.to }],
                subject: mail.subject,
                textContent: mail.text,
                htmlContent: mail.html,
              }
            : {
                sender: { email: addressFromMailbox(from) },
                to: [{ email: mail.to }],
                subject: mail.subject,
                textContent: mail.text,
              };
        const res = await fetch("https://api.brevo.com/v3/smtp/email", {
          method: "POST",
          headers: {
            "api-key": brevo,
            "content-type": "application/json",
          },
          body: JSON.stringify(body),
          redirect: "error",
          signal: AbortSignal.timeout(15_000),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(`brevo_send_failed:${res.status}:${detail}`);
        }
        const payload = await readJson(res);
        const id =
          isJsonObject(payload) && isString(payload.messageId)
            ? payload.messageId
            : "";
        return { id };
      },
    };
  }
  return undefined;
}

/**
 * Build the deployment's mailer.
 *
 * ESP keys and `OPENSESAME_SMTP_URL` are `@sensitive` in `.env.schema`;
 * `OPENSESAME_MAIL_FROM` is `@public`.
 */
export function createMailer(
  env: NodeJS.ProcessEnv,
  config: ControlPlaneConfig,
): Mailer {
  const smtpUrl = env.OPENSESAME_SMTP_URL?.trim();
  const from = env.OPENSESAME_MAIL_FROM?.trim() || defaultFrom(config);
  const captured: CapturedMail[] = [];
  const http = pickHttpEsp(env);

  if (!http && !smtpUrl && !config.allowDevDefaults) {
    return {
      outbox: captured,
      async send() {
        throw new MailerNotConfiguredError();
      },
    };
  }

  if (http) {
    return {
      outbox: captured,
      async send(mail) {
        const result = await http.send(mail, from);
        captured.push({
          messageId: result.id,
          envelope: { from, to: [mail.to] },
          body: JSON.stringify({
            provider: http.id,
            to: mail.to,
            subject: mail.subject,
            text: mail.text,
          }),
        });
        if (captured.length > MAX_CAPTURED) captured.splice(0, 1);
      },
    };
  }

  const transport = smtpUrl
    ? createTransport({ url: smtpUrl })
    : createTransport({ jsonTransport: true });

  return {
    outbox: captured,
    async send(mail) {
      const message =
        mail.html !== undefined
          ? {
              from,
              to: mail.to,
              subject: mail.subject,
              text: mail.text,
              html: mail.html,
            }
          : {
              from,
              to: mail.to,
              subject: mail.subject,
              text: mail.text,
            };
      const info = await transport.sendMail(message);
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
