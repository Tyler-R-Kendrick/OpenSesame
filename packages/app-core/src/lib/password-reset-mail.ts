/**
 * Mailboxes a vault may use for password reset, and the pure match from a
 * message to a login. A mailbox is an `email-account` item in the vault, so it
 * is sealed, synced, shared and trashed like any other item and a vault with no
 * such item has none: a missing item does not copy another vault's addresses.
 * An account binds one by its item id (`AccountItem.resetEmailId`).
 *
 * This file is the reading half, shared with the item editor and the model
 * plane's readiness check. Writing a mailbox, installing its type and reading
 * its mail live in `./password-reset/`, which only the capability loads. The
 * message reader is a seam; nothing here fetches mail.
 */

import { isString } from "@opensesame/os-domain";
import {
  type AccountItem,
  type TypedItem,
  type VaultItem,
  activeItems,
} from "@opensesame/vault-core";
import type { FieldValues } from "@opensesame/vault-item-types";

/** The item type a mailbox is kept in. */
export const RESET_MAILBOX_TYPE = "email-account";

/** What the match needs of a mailbox. */
export type ResetEmail = { id: string; address: string };

/** A mailbox as a list shows it. Never a credential. */
export type ResetMailbox = ResetEmail & {
  /** The item's name, else its address. */
  name: string;
  /**
   * Whether the app can read its mail: a JMAP server over TLS and a password.
   * A browser cannot open an IMAP or POP3 socket, so those are kept as the
   * server a mailbox names and are not read here. An address alone is still a
   * mailbox a login can bind, and its address is what the reset form is given.
   */
  readable: boolean;
};

export type ResetMailMessage = {
  /** The reader's own id for the message, so a message is acted on once. */
  id?: string;
  mailbox: string;
  subject: string;
  text: string;
};

export type ResetLoginRef = {
  id: string;
  resetEmailId?: string;
  uris: readonly string[];
};

export type ResetMailMatch = {
  itemId: string;
  origin: string;
  /** The message that matched, when the reader gave it an id. */
  messageId?: string;
};

type Ready = () => boolean | Promise<boolean>;
let ready: Ready = () => false;

export const passwordResetMailSeams = {
  listMessages: async (_address: string): Promise<ResetMailMessage[]> => [],
};

/** The website password-reset ceremony is reachable. Default is no. */
export function installAutonomousResetReady(next: Ready): () => void {
  const previous = ready;
  ready = next;
  return () => {
    if (ready === next) ready = previous;
  };
}

export async function autonomousPasswordResetReady(): Promise<boolean> {
  return ready();
}

export function resetPasswordResetMailForTest(): void {
  ready = () => false;
  passwordResetMailSeams.listMessages = async () => [];
}

export function normalizeResetAddress(input: string): string | null {
  const address = input.trim().toLowerCase();
  if (address.length < 3 || address.length > 254) return null;
  const at = address.indexOf("@");
  if (at <= 0 || at !== address.lastIndexOf("@")) return null;
  const domain = address.slice(at + 1);
  if (!domain.includes(".") || domain.startsWith(".") || domain.endsWith(".")) {
    return null;
  }
  if (/[\s/]/.test(address)) return null;
  return address;
}

export function isMailboxItem(item: VaultItem): item is TypedItem {
  return item.kind === "typed" && item.typeId === RESET_MAILBOX_TYPE;
}

function text(value: FieldValues[string] | undefined): string {
  return isString(value) ? value.trim() : "";
}

function hostOf(value: FieldValues[string] | undefined): string {
  if (value === undefined || isString(value) || Array.isArray(value)) return "";
  return (value.host ?? "").trim();
}

/** The incoming protocol the in-browser reader speaks. */
export const READABLE_PROTOCOL = "jmap";

/** The mailbox an item is, or `null` when it is not one or its address is not one. */
export function mailboxOf(item: VaultItem): ResetMailbox | null {
  if (!isMailboxItem(item)) return null;
  const address = normalizeResetAddress(text(item.values.address));
  if (address === null) return null;
  return {
    id: item.id,
    address,
    name: item.name.trim() || address,
    readable:
      hostOf(item.values.incoming) !== "" &&
      text(item.values.password) !== "" &&
      text(item.values.incomingProtocol) === READABLE_PROTOCOL &&
      text(item.values.security) !== "none",
  };
}

/** The vault's mailboxes in name order. Zero, one or many; trashed ones are not listed. */
export function resetMailboxes(
  items: readonly VaultItem[],
): readonly ResetMailbox[] {
  return activeItems([...items])
    .flatMap((item) => mailboxOf(item) ?? [])
    .sort((a, b) => a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

/** The accounts that name a mailbox as theirs. */
export function accountsBoundTo(
  items: readonly VaultItem[],
  mailboxId: string,
): readonly AccountItem[] {
  return activeItems([...items]).filter(
    (item): item is AccountItem =>
      item.kind === "account" && item.resetEmailId === mailboxId,
  );
}

const RESET_HINT = /\b(reset|recover|recovery)\b|change[ -]?password/i;
const RESET_PATH =
  /reset|recover|change-password|changepassword|password-reset|forgot/i;
const URL_IN_TEXT = /https:\/\/[^\s<>"']+/g;

export function matchResetMail(
  emails: readonly ResetEmail[],
  items: readonly ResetLoginRef[],
  messages: readonly ResetMailMessage[],
): ResetMailMatch[] {
  const byAddress = new Map(emails.map((email) => [email.address, email.id]));
  const seen = new Set<string>();
  const matches: ResetMailMatch[] = [];
  for (const message of messages) {
    const emailId = byAddress.get(message.mailbox.trim().toLowerCase());
    const link = emailId ? resetUrl(message) : null;
    if (!emailId || !link) continue;
    for (const item of items) {
      if (item.resetEmailId !== emailId) continue;
      const origin = originFor(link, item.uris);
      if (origin === null) continue;
      const key = `${item.id}\n${origin}\n${message.id ?? ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({
        itemId: item.id,
        origin,
        ...(message.id === undefined ? undefined : { messageId: message.id }),
      });
    }
  }
  return matches;
}

function resetUrl(message: ResetMailMessage): URL | null {
  const blob = `${message.subject}\n${message.text}`;
  if (!RESET_HINT.test(blob)) return null;
  for (const raw of blob.match(URL_IN_TEXT) ?? []) {
    const url = httpsUrl(raw);
    if (url && url.pathname !== "/" && RESET_PATH.test(url.pathname))
      return url;
  }
  return null;
}

function originFor(link: URL, uris: readonly string[]): string | null {
  for (const uri of uris) {
    const parsed = httpsUrl(uri.includes("://") ? uri : `https://${uri}`);
    if (parsed?.hostname === link.hostname) return parsed.origin;
  }
  // An email chooses the message, never the site a credential is rotated at.
  return null;
}

function httpsUrl(raw: string): URL | null {
  try {
    const url = new URL(raw.replace(/[),.;]+$/, ""));
    if (url.protocol !== "https:" || url.username || url.password) return null;
    return url;
  } catch {
    return null;
  }
}
