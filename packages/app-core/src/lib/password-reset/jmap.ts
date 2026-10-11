/**
 * Reading recent mail over JMAP (RFC 8620, RFC 8621): the one mail protocol a
 * page can speak, since it is HTTPS and a browser cannot open an IMAP or POP3
 * socket. A pass asks the server for the messages that arrived since a time and
 * returns each one's subject and plain text, which `matchResetMail` reads for a
 * reset link.
 *
 * The fetch is handed in — the capability's egress port in the app, a fake in a
 * test — so every request goes where the person named and nowhere else:
 *
 * - the session document is looked for at `/jmap/session` and then
 *   `/.well-known/jmap` of the named server, and a redirect is not followed
 *   (the egress port refuses them);
 * - the `apiUrl` it names must be on the same origin as the session, or the
 *   login would be sent to a place the person never chose;
 * - an error carries a code and nothing the server said, and never the login;
 * - a pass has one deadline for the session, the call and reading both bodies,
 *   so a server that never answers ends as `unreachable` and cannot hold the
 *   scan that called it.
 */

import { isJsonObject, isString, overlapCast } from "@opensesame/os-domain";
import type { JsonObject, JsonValue } from "@opensesame/os-domain";
import type { ResetMailMessage } from "../password-reset-mail.js";
import type { MailConnection } from "./mailbox-connection.js";

export type MailFetch = (url: string, init: RequestInit) => Promise<Response>;

export type JmapFailure =
  | "unreachable"
  | "unauthorized"
  | "unsupported"
  | "malformed";

export class JmapError extends Error {
  readonly code: JmapFailure;
  constructor(code: JmapFailure) {
    super(`the mail server could not be read (${code})`);
    this.name = "JmapError";
    this.code = code;
  }
}

const CORE = "urn:ietf:params:jmap:core";
const MAIL = "urn:ietf:params:jmap:mail";
const SESSION_PATHS = ["/jmap/session", "/.well-known/jmap"] as const;
const DEFAULT_LIMIT = 25;
const MAX_BODY_BYTES = 16_384;
/** The whole pass: the session, the call and the bodies. */
const PASS_TIMEOUT_MS = 30_000;

export type ReadOptions = {
  /** Only messages received at or after this time. */
  since: Date;
  limit?: number;
};

function authorization(connection: MailConnection): string {
  if (connection.username === "") return `Bearer ${connection.password}`;
  const bytes = new TextEncoder().encode(
    `${connection.username}:${connection.password}`,
  );
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `Basic ${btoa(binary)}`;
}

async function request(
  fetcher: MailFetch,
  url: string,
  init: RequestInit,
  signal: AbortSignal,
): Promise<Response> {
  try {
    return await fetcher(url, { ...init, signal });
  } catch {
    throw new JmapError("unreachable");
  }
}

async function jsonOf(
  response: Response,
  signal: AbortSignal,
): Promise<JsonObject> {
  try {
    const body = overlapCast(await response.json());
    if (isJsonObject(body)) return body;
  } catch {
    // Not JSON: the same answer as JSON of the wrong shape, unless the
    // deadline cut the body short.
    if (signal.aborted) throw new JmapError("unreachable");
  }
  throw new JmapError("malformed");
}

type Session = { apiUrl: string; accountId: string };

function accountOf(session: JsonObject): string | null {
  const primary = session.primaryAccounts;
  if (isJsonObject(primary) && isString(primary[MAIL])) return primary[MAIL];
  const accounts = session.accounts;
  if (isJsonObject(accounts)) return Object.keys(accounts)[0] ?? null;
  return null;
}

async function openSession(
  connection: MailConnection,
  fetcher: MailFetch,
  signal: AbortSignal,
): Promise<Session> {
  const headers = {
    authorization: authorization(connection),
    accept: "application/json",
  };
  let last: JmapFailure = "unsupported";
  for (const path of SESSION_PATHS) {
    const response = await request(
      fetcher,
      `${connection.origin}${path}`,
      { method: "GET", headers, credentials: "omit", redirect: "manual" },
      signal,
    );
    if (response.status === 401 || response.status === 403) {
      throw new JmapError("unauthorized");
    }
    if (!response.ok) continue;
    const session = await jsonOf(response, signal);
    const accountId = accountOf(session);
    if (!isString(session.apiUrl) || accountId === null) {
      last = "malformed";
      continue;
    }
    const api = parseUrl(session.apiUrl, connection.origin);
    // The login follows the apiUrl, so it must stay on the server named.
    if (api === null || api.origin !== connection.origin) {
      throw new JmapError("malformed");
    }
    return { apiUrl: api.toString(), accountId };
  }
  throw new JmapError(last);
}

function parseUrl(raw: string, base: string): URL | null {
  try {
    return new URL(raw, base);
  } catch {
    return null;
  }
}

function methodCalls(
  accountId: string,
  options: ReadOptions,
): readonly JsonValue[] {
  return [
    [
      "Email/query",
      {
        accountId,
        filter: { after: options.since.toISOString() },
        sort: [{ property: "receivedAt", isAscending: false }],
        limit: options.limit ?? DEFAULT_LIMIT,
      },
      "q",
    ],
    [
      "Email/get",
      {
        accountId,
        "#ids": { resultOf: "q", name: "Email/query", path: "/ids" },
        properties: ["id", "subject", "receivedAt", "textBody", "bodyValues"],
        fetchTextBodyValues: true,
        maxBodyValueBytes: MAX_BODY_BYTES,
      },
      "g",
    ],
  ];
}

function textOf(email: JsonObject): string {
  const values = email.bodyValues;
  const parts = email.textBody;
  if (!isJsonObject(values) || !Array.isArray(parts)) return "";
  const texts: string[] = [];
  for (const part of parts) {
    if (!isJsonObject(part) || !isString(part.partId)) continue;
    const value = values[part.partId];
    if (isJsonObject(value) && isString(value.value)) texts.push(value.value);
  }
  return texts.join("\n");
}

function messagesOf(
  body: JsonObject,
  connection: MailConnection,
): ResetMailMessage[] {
  const responses = body.methodResponses;
  if (!Array.isArray(responses)) throw new JmapError("malformed");
  for (const response of responses) {
    if (!Array.isArray(response) || response[0] !== "Email/get") continue;
    const result = response[1];
    if (!isJsonObject(result) || !Array.isArray(result.list)) {
      throw new JmapError("malformed");
    }
    return result.list.flatMap((email): ResetMailMessage[] =>
      isJsonObject(email) && isString(email.id)
        ? [
            {
              id: email.id,
              mailbox: connection.address,
              subject: isString(email.subject) ? email.subject : "",
              text: textOf(email),
            },
          ]
        : [],
    );
  }
  // An `error` response, or a server that answered something else.
  throw new JmapError("unsupported");
}

/** The messages that arrived in the mailbox since `options.since`, newest first. */
export async function readRecentMessages(
  connection: MailConnection,
  fetcher: MailFetch,
  options: ReadOptions,
): Promise<ResetMailMessage[]> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), PASS_TIMEOUT_MS);
  const { signal } = deadline;
  try {
    const session = await openSession(connection, fetcher, signal);
    const response = await request(
      fetcher,
      session.apiUrl,
      {
        method: "POST",
        headers: {
          authorization: authorization(connection),
          "content-type": "application/json",
          accept: "application/json",
        },
        credentials: "omit",
        redirect: "manual",
        body: JSON.stringify({
          using: [CORE, MAIL],
          methodCalls: methodCalls(session.accountId, options),
        }),
      },
      signal,
    );
    if (response.status === 401 || response.status === 403) {
      throw new JmapError("unauthorized");
    }
    if (!response.ok) throw new JmapError("unsupported");
    return messagesOf(await jsonOf(response, signal), connection);
  } finally {
    clearTimeout(timer);
  }
}
