/**
 * How the terminal reads and writes an account's password (ADR 0174). Every
 * password is produced through the vault-core facade, so the terminal knows no
 * technique: a stored one, one an algorithm computes and one with a slot for the
 * person's own pepper all come out of `producePassword`. The terminal never asks
 * for a pepper and never stores one; what it copies stops before the slot, and
 * `--field rest` copies what follows it.
 */
import { shareText } from "@opensesame/app-core/sections/vault-section-model.js";
import {
  type AccountItem,
  type VaultItem,
  handoff,
  manualPassword,
  passwordMethod,
  produceAccountPassword,
} from "@opensesame/vault-core";

/** An account an older version made from a pepper the person typed: only the app converts it. */
export class LegacyPasswordError extends Error {
  readonly code = "legacy_password";
  constructor(itemName: string) {
    super(
      `legacy_password: ${itemName} was made with an earlier pepper; open it in the vault app to convert it`,
    );
    this.name = "LegacyPasswordError";
  }
}

/**
 * A typed password is the account's first password method, as `manual`. The
 * method keeps its place, and where its pepper goes if it has one.
 */
export function withPassword(item: AccountItem, value: string): AccountItem {
  const current = passwordMethod(item);
  const typed = manualPassword(
    current?.id ?? `${item.id}:password`,
    value,
    new Date().toISOString(),
  );
  if (!current) return { ...item, methods: [typed, ...item.methods] };
  const replacement =
    current.pepper && current.sealed === undefined
      ? {
          ...typed,
          pepper: true,
          ...(current.pepperAt === undefined
            ? undefined
            : { pepperAt: current.pepperAt }),
        }
      : typed;
  return {
    ...item,
    methods: item.methods.map((method) =>
      method.id === current.id ? replacement : method,
    ),
  };
}

/**
 * What `vault copy` puts on the clipboard. For `rest`, what follows the pepper's
 * slot. Null when there is nothing to copy; a legacy password is refused.
 */
export function secretText(
  item: VaultItem,
  part: "now" | "later" = "now",
): string | null {
  if (item.kind !== "account") return part === "later" ? null : shareText(item);
  const produced = produceAccountPassword(item);
  if (produced.status === "legacy") throw new LegacyPasswordError(item.name);
  const out = handoff(produced);
  const text = out === null ? "" : out[part];
  return text === "" ? null : text;
}

/** Whether copying an account's password leaves a slot for the person's pepper. */
export function leavesPepperSlot(item: VaultItem): boolean {
  return (
    item.kind === "account" && produceAccountPassword(item).status === "slotted"
  );
}
