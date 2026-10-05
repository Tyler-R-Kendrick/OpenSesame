import {
  type AccountItem,
  DEFAULT_RULES,
  LOGIN_METHOD_TYPES,
  type LoginMethod,
  type LoginMethodType,
  mintRootSecret,
  newMethodId,
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
  const id = newMethodId(account.id, type);
  switch (type) {
    case "password": {
      const generator = {
        id: "derived",
        rules: { ...DEFAULT_RULES },
        counter: 0,
      } as const;
      return {
        id,
        type,
        generator,
        pepper: true,
        secret: mintRootSecret(),
        changedAt: now.toISOString(),
      };
    }
    case "api-key":
      return { id, type, key: "", header: "X-Api-Key" };
    case "token":
      return { id, type, token: "", expiresAt: "" };
    case "oauth":
      return {
        id,
        type,
        clientId: "",
        clientSecret: "",
        tokenUrl: "",
        scopes: "",
        refreshToken: "",
      };
    case "authenticator":
      return { id, type, secret: "" };
  }
}

/**
 * The choice of what to add: one key per method type, opened by the heading's
 * `+`. Focus lands on the first and Escape closes it back to the `+`.
 */
export function MethodPicker({
  opener,
  onPick,
  onClose,
}: {
  opener: RefObject<HTMLButtonElement | null>;
  onPick: (type: LoginMethodType) => void;
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
      {LOGIN_METHOD_TYPES.map((type) => (
        <button
          key={type}
          type="button"
          className="btn btn--sm choice"
          onClick={() => onPick(type)}
        >
          {METHOD_LABELS[type]}
        </button>
      ))}
    </fieldset>
  );
}
