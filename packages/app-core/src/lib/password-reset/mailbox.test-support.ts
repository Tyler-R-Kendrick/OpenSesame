/**
 * Shared set-up for the reset mailbox tests: an `email-account` item made from
 * the embedded definition, with the fields a test names and no others.
 */

import {
  type TypedItem,
  createTypedItem,
  itemTypeRegistry,
} from "@opensesame/vault-core";
import { RESET_MAIL_TYPES } from "./mail-type.generated.js";

/** The fields of an `email-account` item the reset tests set. */
export type MailboxValues = {
  address: string;
  username?: string;
  password?: string;
  incoming?: { host: string; port: string };
  incomingProtocol?: string;
  security?: string;
};

/** A mailbox the reader can use, to spread over and override. */
export const JMAP_MAILBOX: MailboxValues = {
  address: "me@example.com",
  username: "me@example.com",
  password: "app-password-1",
  incoming: { host: "mail.example.com", port: "443" },
  incomingProtocol: "jmap",
  security: "tls",
};

export function mailboxItem(values: MailboxValues, name = ""): TypedItem {
  const installed = itemTypeRegistry().install(
    RESET_MAIL_TYPES[0].text,
    "vault",
  );
  const definition = installed.ok
    ? installed.definition
    : itemTypeRegistry().get("email-account");
  if (!definition) throw new Error("no email-account type");
  return createTypedItem(definition, values, name);
}
