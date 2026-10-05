/**
 * How the terminal reads and writes an account's password (ADR 0171 §4). A
 * password that is peppered or Sphinx-derived is absent here: the CLI never
 * reveals, accepts or logs a pepper, a sealed envelope or a method secret.
 */
import { shareText } from "@opensesame/app-core/sections/vault-section-model.js";
import {
  type AccountItem,
  type VaultItem,
  accountPlainPassword,
  manualPassword,
  needsPepper,
  passwordMethod,
} from "@opensesame/vault-core";

/**
 * A password the terminal cannot ask a pepper for is absent here: the CLI
 * never reveals, accepts or logs a pepper or a sealed envelope (ADR 0171 §4).
 */
export class NeedsPepperError extends Error {
  readonly code = "needs_pepper";
  constructor(itemName: string) {
    super(
      `needs_pepper: the password of ${itemName} needs a pepper; open it in the vault app`,
    );
    this.name = "NeedsPepperError";
  }
}

/**
 * A typed password is the account's first password method, as `manual`. A
 * method that is peppered or Sphinx-derived is never overwritten from a
 * terminal: that would need the pepper, which only the vault app asks for.
 */
export function withPassword(item: AccountItem, value: string): AccountItem {
  const current = passwordMethod(item);
  const typed = manualPassword(
    current?.id ?? `${item.id}:password`,
    value,
    new Date().toISOString(),
  );
  if (!current) return { ...item, methods: [typed, ...item.methods] };
  if (needsPepper(current)) throw new NeedsPepperError(item.name);
  return {
    ...item,
    methods: item.methods.map((method) =>
      method.id === current.id ? typed : method,
    ),
  };
}

/** What `vault copy` puts on the clipboard; a peppered password is refused, not sealed-copied. */
export function secretText(item: VaultItem): string | null {
  if (item.kind !== "account") return shareText(item);
  const method = passwordMethod(item);
  if (method && needsPepper(method)) throw new NeedsPepperError(item.name);
  const plain = accountPlainPassword(item);
  return plain === "" ? null : plain;
}
