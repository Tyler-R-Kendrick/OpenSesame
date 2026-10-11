import type { MailboxRefusal } from "@opensesame/app-core/lib/password-reset/mailbox-store.js";

/** The sentence a tray notice carries when a mailbox is not saved. Never a value. */
export function refusalText(refusal: MailboxRefusal): string {
  switch (refusal) {
    case "address":
      return "That is not an email address.";
    case "duplicate":
      return "That address is already a mailbox.";
    case "port":
      return "The port is a number from 1 to 65535.";
    case "missing":
      return "That mailbox is no longer in the vault.";
  }
}

/** The field a refusal marks, if it was a field's fault. */
export function refusalField(
  refusal: MailboxRefusal,
): "address" | "port" | null {
  switch (refusal) {
    case "address":
    case "duplicate":
      return "address";
    case "port":
      return "port";
    case "missing":
      return null;
  }
}
