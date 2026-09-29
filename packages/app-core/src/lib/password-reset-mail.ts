/**
 * Mailboxes a vault may use for password reset, and the pure match from a
 * message to a login. The list is configuration, one tomb at a time, in the
 * same sense as capability bindings: a missing map does not copy another
 * vault's addresses. The message reader is a seam; nothing here fetches mail.
 */

import {
  type JsonObject,
  type JsonValue,
  isJsonObject,
  isString,
  overlapCast,
} from "@opensesame/os-domain";
import { activeCapabilityVaultId } from "./capability-connector-scope.js";
import { kvDelete, kvGet, kvSet } from "./kv.js";

export const PASSWORD_RESET_MAIL_KEY = "password-reset-mail.v1";

export type ResetEmail = { id: string; address: string };

export type ResetMailMessage = {
  mailbox: string;
  subject: string;
  text: string;
};

export type ResetLoginRef = {
  id: string;
  resetEmailId?: string;
  uris: readonly string[];
};

export type ResetMailMatch = { itemId: string; origin: string };

const listeners = new Set<() => void>();
let epoch = 0;

type Ready = () => boolean | Promise<boolean>;
let ready: Ready = () => false;

export const passwordResetMailSeams = {
  listMessages: async (_address: string): Promise<ResetMailMessage[]> => [],
};

export function resetEmailEpoch(): number {
  return epoch;
}

export function subscribeResetEmails(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

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
  kvDelete(PASSWORD_RESET_MAIL_KEY);
  ready = () => false;
  passwordResetMailSeams.listMessages = async () => [];
  emit();
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

export function listResetEmails(
  vaultId = activeCapabilityVaultId(),
): readonly ResetEmail[] {
  return readAll().byVault[vaultId] ?? [];
}

export function addResetEmail(
  input: string,
  vaultId = activeCapabilityVaultId(),
): ResetEmail | null {
  const address = normalizeResetAddress(input);
  if (!address) return null;
  const all = readAll();
  const current = all.byVault[vaultId] ?? [];
  if (current.some((email) => email.address === address)) return null;
  const email = { id: crypto.randomUUID(), address };
  all.byVault[vaultId] = [...current, email];
  writeAll(all);
  return email;
}

export function removeResetEmail(
  id: string,
  vaultId = activeCapabilityVaultId(),
): void {
  const all = readAll();
  const current = all.byVault[vaultId] ?? [];
  const next = current.filter((email) => email.id !== id);
  if (next.length === current.length) return;
  if (next.length === 0) delete all.byVault[vaultId];
  else all.byVault[vaultId] = next;
  writeAll(all);
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
      const key = `${item.id}\n${origin}`;
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ itemId: item.id, origin });
    }
  }
  return matches;
}

function emit(): void {
  epoch += 1;
  for (const listener of listeners) listener();
}

type Stored = { byVault: Record<string, ResetEmail[]> };

function readAll(): Stored {
  const raw = kvGet(PASSWORD_RESET_MAIL_KEY);
  if (!raw) return { byVault: {} };
  try {
    const parsed = overlapCast(JSON.parse(raw));
    if (!isJsonObject(parsed) || !isJsonObject(parsed.byVault)) {
      return { byVault: {} };
    }
    return { byVault: emailsByVault(parsed.byVault) };
  } catch {
    return { byVault: {} };
  }
}

function writeAll(stored: Stored): void {
  kvSet(PASSWORD_RESET_MAIL_KEY, JSON.stringify(stored));
  emit();
}

function emailsByVault(value: JsonObject): Record<string, ResetEmail[]> {
  const byVault: Record<string, ResetEmail[]> = {};
  for (const [vaultId, entries] of Object.entries(value)) {
    if (!Array.isArray(entries)) continue;
    const emails = entries.flatMap(emailFrom);
    if (emails.length > 0) byVault[vaultId] = emails;
  }
  return byVault;
}

function emailFrom(value: JsonValue): ResetEmail[] {
  if (!isJsonObject(value) || !isString(value.id) || !isString(value.address)) {
    return [];
  }
  const address = normalizeResetAddress(value.address);
  if (!address) return [];
  return [{ id: value.id, address }];
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

function originFor(link: URL, uris: readonly string[]): string {
  for (const uri of uris) {
    const parsed = httpsUrl(uri.includes("://") ? uri : `https://${uri}`);
    if (parsed?.hostname === link.hostname) return parsed.origin;
  }
  return link.origin;
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
