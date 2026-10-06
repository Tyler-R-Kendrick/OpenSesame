import {
  type AccountItem,
  type CredentialItem,
  type LoginMethod,
  type LoginMethodType,
  newLoginMethod,
} from "@opensesame/vault-core";
import { type RefObject, useEffect, useRef } from "react";

export const METHOD_LABELS = {
  password: "Password",
  "api-key": "API key",
  token: "Token",
  oauth: "OAuth",
  authenticator: "Authenticator",
} as const satisfies Record<LoginMethodType, string>;

/** The type's label, numbered when the account holds more than one of it. */
export function methodTitle(
  methods: readonly LoginMethod[],
  method: LoginMethod,
): string {
  const same = methods.filter((entry) => entry.type === method.type);
  const label = METHOD_LABELS[method.type];
  return same.length > 1 ? `${label} ${same.indexOf(method) + 1}` : label;
}

/** A new, empty method of a type. A password starts with a generated one. */
export function newMethod(
  account: Pick<AccountItem, "id">,
  type: LoginMethodType,
  now: Date = new Date(),
): LoginMethod {
  return newLoginMethod(type, account.id, now);
}

/**
 * The choice of what to add, opened by the heading's `+`: one key per method
 * type to make a new one, and one per credential the vault keeps on its own to
 * bind it to this account. Focus lands on the first and Escape closes it back
 * to the `+`.
 */
export function MethodPicker({
  opener,
  types,
  existing,
  onPick,
  onBind,
  onClose,
}: {
  opener: RefObject<HTMLButtonElement | null>;
  types: readonly LoginMethodType[];
  /** Credentials kept on their own, which this account may take. */
  existing: readonly CredentialItem[];
  onPick: (type: LoginMethodType) => void;
  onBind: (credential: CredentialItem) => void;
  onClose: () => void;
}) {
  const group = useRef<HTMLFieldSetElement>(null);
  useEffect(() => {
    group.current?.querySelector<HTMLElement>("button")?.focus();
  }, []);
  return (
    <fieldset
      ref={group}
      className="method__picker"
      aria-label="Login method type"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onClose();
        opener.current?.focus();
      }}
    >
      {types.map((type) => (
        <button
          key={type}
          type="button"
          className="btn btn--sm choice"
          onClick={() => onPick(type)}
        >
          {METHOD_LABELS[type]}
        </button>
      ))}
      {existing.length > 0 ? (
        <fieldset
          className="method__existing"
          aria-label="Existing credentials"
        >
          {existing.map((credential) => (
            <button
              key={credential.id}
              type="button"
              className="btn btn--sm choice"
              onClick={() => onBind(credential)}
            >
              {credential.name || METHOD_LABELS[credential.method.type]}
            </button>
          ))}
        </fieldset>
      ) : null}
    </fieldset>
  );
}
