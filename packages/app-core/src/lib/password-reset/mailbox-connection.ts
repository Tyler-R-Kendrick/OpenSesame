/**
 * What reading a mailbox takes, read off its `email-account` item: the origin
 * of its JMAP server and the login for it. This is the one place a mailbox's
 * password leaves the item, and it goes only to the reader; `ResetMailbox`, a
 * list, a log line and an error never carry it.
 */

import { isString } from "@opensesame/os-domain";
import type { VaultItem } from "@opensesame/vault-core";
import { isMailboxItem, mailboxOf } from "../password-reset-mail.js";

export type MailConnection = {
  /** `https://host` or `https://host:port` — nothing else. */
  origin: string;
  /** Blank means the password is a bearer token. */
  username: string;
  password: string;
  /** The mailbox's address, which is what a message is said to be in. */
  address: string;
};

const HOSTNAME = /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?$/i;

/** A host as typed — `mail.example.com`, or pasted with a scheme and a slash. */
function cleanHost(raw: string): string | null {
  const host = raw
    .trim()
    .replace(/^https:\/\//i, "")
    .replace(/\/+$/, "")
    .toLowerCase();
  if (host === "" || !HOSTNAME.test(host) || !host.includes(".")) return null;
  return host;
}

/** Whether the reader can use `raw` as a server: the same rule `connectionOf` applies. */
export function usableHost(raw: string): boolean {
  return cleanHost(raw) !== null;
}

function cleanPort(raw: string): string | null {
  const port = raw.trim();
  if (port === "" || port === "443") return "";
  if (!/^\d{1,5}$/.test(port)) return null;
  const number = Number(port);
  return number >= 1 && number <= 65535 ? String(number) : null;
}

/**
 * The connection a readable mailbox item describes, or `null` when it is not
 * one the in-browser reader can use (no server, no password, not JMAP, not TLS,
 * or a host that is not a plain name).
 */
export function connectionOf(item: VaultItem): MailConnection | null {
  const mailbox = mailboxOf(item);
  if (!mailbox?.readable || !isMailboxItem(item)) return null;
  const incoming = item.values.incoming;
  if (incoming === undefined || isString(incoming) || Array.isArray(incoming)) {
    return null;
  }
  const host = cleanHost(incoming.host ?? "");
  const port = cleanPort(incoming.port ?? "");
  const password = item.values.password;
  if (host === null || port === null || !isString(password)) return null;
  const username = item.values.username;
  return {
    origin: port === "" ? `https://${host}` : `https://${host}:${port}`,
    username: isString(username) ? username.trim() : "",
    password,
    address: mailbox.address,
  };
}
