/**
 * Writing the vault's reset mailboxes: each one an `email-account` item, added,
 * changed and removed through the vault store like any other item. Zero, one
 * or many; the address is all a mailbox needs, and a server and a login are the
 * advanced part that lets the app read what arrives there.
 *
 * A password is a concealed field of the item. `mailboxDraft` never returns
 * it, and a save that leaves it blank keeps the one already there.
 */

import { isString } from "@opensesame/os-domain";
import {
  type TypedItem,
  type VaultItem,
  activeItems,
  createTypedItem,
  itemTypeRegistry,
} from "@opensesame/vault-core";
import type { FieldValues } from "@opensesame/vault-item-types";
import {
  type ResetMailbox,
  isMailboxItem,
  mailboxOf,
  normalizeResetAddress,
} from "../password-reset-mail.js";
import type { VaultStore } from "../vault/store.js";
import { type ResetMailTypeHost, ensureResetMailType } from "./mail-type.js";

export const MAIL_PROTOCOLS = ["imap", "pop3", "jmap", "exchange"] as const;
export const MAIL_SECURITIES = ["tls", "starttls", "none"] as const;

export type MailProtocol = (typeof MAIL_PROTOCOLS)[number];
export type MailSecurity = (typeof MAIL_SECURITIES)[number];

/** The advanced half of a mailbox: where its mail is and who may read it. */
export type MailboxServer = {
  host: string;
  port: string;
  protocol: MailProtocol;
  security: MailSecurity;
  username: string;
  /** Blank on an edit keeps the password the item already holds. */
  password: string;
};

export type MailboxDraft = {
  address: string;
  name: string;
  server: MailboxServer;
};

/** What writing a mailbox takes of the store; the real one by default. */
export type MailboxVault = Pick<
  VaultStore,
  "getSnapshot" | "saveItem" | "trashItem"
> &
  ResetMailTypeHost;

export const NO_SERVER: MailboxServer = {
  host: "",
  port: "",
  protocol: "jmap",
  security: "tls",
  username: "",
  password: "",
};

export const EMPTY_DRAFT: MailboxDraft = {
  address: "",
  name: "",
  server: NO_SERVER,
};

/** Why a mailbox was not saved. A screen marks the field; it never quotes a value. */
export type MailboxRefusal = "address" | "duplicate" | "port" | "missing";

export type MailboxSave =
  | { readonly ok: true; readonly mailbox: ResetMailbox }
  | { readonly ok: false; readonly refusal: MailboxRefusal };

function text(value: FieldValues[string] | undefined): string {
  return isString(value) ? value : "";
}

function part(
  value: FieldValues[string] | undefined,
  key: "host" | "port",
): string {
  if (value === undefined || isString(value) || Array.isArray(value)) return "";
  return value[key] ?? "";
}

function oneOf<T extends string>(
  choices: readonly T[],
  value: string,
  fallback: T,
): T {
  return choices.find((choice) => choice === value) ?? fallback;
}

/** The form's start for an existing mailbox. The password is left blank. */
export function mailboxDraft(item: VaultItem): MailboxDraft | null {
  if (!isMailboxItem(item)) return null;
  return {
    address: text(item.values.address),
    name: item.name,
    server: {
      host: part(item.values.incoming, "host"),
      port: part(item.values.incoming, "port"),
      protocol: oneOf(
        MAIL_PROTOCOLS,
        text(item.values.incomingProtocol),
        "jmap",
      ),
      security: oneOf(MAIL_SECURITIES, text(item.values.security), "tls"),
      username: text(item.values.username),
      password: "",
    },
  };
}

function validPort(port: string): boolean {
  if (port === "") return true;
  if (!/^\d{1,5}$/.test(port)) return false;
  const number = Number(port);
  return number >= 1 && number <= 65535;
}

function valuesOf(
  draft: MailboxDraft,
  address: string,
  existing: TypedItem | undefined,
): FieldValues {
  const { server } = draft;
  const host = server.host.trim();
  const kept = text(existing?.values.password);
  // With no server there is nothing a login would open: the advanced half is
  // left empty rather than kept half-written.
  if (host === "") return { address };
  return {
    address,
    username: server.username.trim(),
    password: server.password !== "" ? server.password : kept,
    incoming: { host, port: server.port.trim() },
    incomingProtocol: server.protocol,
    security: server.security,
  };
}

function duplicate(
  items: readonly VaultItem[],
  address: string,
  except: string | undefined,
): boolean {
  return activeItems([...items]).some(
    (item) => item.id !== except && mailboxOf(item)?.address === address,
  );
}

type Checked =
  | { readonly ok: true; readonly address: string }
  | { readonly ok: false; readonly refusal: MailboxRefusal };

function check(
  draft: MailboxDraft,
  items: readonly VaultItem[],
  id?: string,
): Checked {
  const address = normalizeResetAddress(draft.address);
  if (address === null) return { ok: false, refusal: "address" };
  if (!validPort(draft.server.port.trim())) {
    return { ok: false, refusal: "port" };
  }
  if (duplicate(items, address, id)) return { ok: false, refusal: "duplicate" };
  return { ok: true, address };
}

/** Add a mailbox. Installs the type on first use. */
export async function addMailbox(
  store: MailboxVault,
  draft: MailboxDraft,
): Promise<MailboxSave> {
  const checked = check(draft, store.getSnapshot().items);
  if (!checked.ok) return checked;
  const { address } = checked;
  await ensureResetMailType(store);
  const definition = itemTypeRegistry().get("email-account");
  if (!definition) throw new Error("email-account is not installed");
  const item = createTypedItem(
    definition,
    valuesOf(draft, address, undefined),
    draft.name.trim() || address,
  );
  await store.saveItem(item);
  const mailbox = mailboxOf(item);
  if (!mailbox) throw new Error("a saved mailbox did not read back");
  return { ok: true, mailbox };
}

/** Change a mailbox in place, so a login bound to it stays bound. */
export async function updateMailbox(
  store: MailboxVault,
  id: string,
  draft: MailboxDraft,
): Promise<MailboxSave> {
  const existing = store
    .getSnapshot()
    .items.find(
      (item): item is TypedItem => item.id === id && isMailboxItem(item),
    );
  if (!existing) return { ok: false, refusal: "missing" };
  const checked = check(draft, store.getSnapshot().items, id);
  if (!checked.ok) return checked;
  const { address } = checked;
  const item: TypedItem = {
    ...existing,
    name: draft.name.trim() || address,
    values: valuesOf(draft, address, existing),
  };
  await store.saveItem(item);
  const mailbox = mailboxOf(item);
  if (!mailbox) throw new Error("a saved mailbox did not read back");
  return { ok: true, mailbox };
}

/** Move a mailbox to the trash. A login still naming it simply has none. */
export async function removeMailbox(
  store: MailboxVault,
  id: string,
): Promise<void> {
  const found = store.getSnapshot().items.find((item) => item.id === id);
  if (found && isMailboxItem(found)) await store.trashItem(id);
}
