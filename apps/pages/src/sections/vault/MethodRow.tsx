import type {
  AccountItem,
  LoginMethod,
  PasswordMethod,
} from "@opensesame/vault-core";
import {
  ApiKeyRows,
  AuthenticatorRows,
  type MethodRowPorts,
  OAuthRows,
  TokenRows,
} from "./AccountMethodRows.js";
import { AccountPasswordRow } from "./AccountPasswordRow.js";
import { methodTitle } from "./MethodPicker.js";

/**
 * One login method's rows on a detail page: an account's, or a credential's
 * own (ADR 0178), which is the same rows with no account around it.
 */
export function MethodRow({
  account,
  method,
  methods,
  ports,
  guide,
  onSave,
}: {
  /** What a password row reads of its owner: an id and a username. */
  account: Pick<AccountItem, "id" | "username">;
  method: LoginMethod;
  /** The credentials it is numbered among. */
  methods: readonly LoginMethod[];
  ports: MethodRowPorts;
  /** This row holds the tutorials' `item.copy-password` target. */
  guide: boolean;
  onSave: (method: PasswordMethod) => Promise<void>;
}) {
  const { copied, failed, copy } = ports;
  switch (method.type) {
    case "password":
      return (
        <AccountPasswordRow
          item={account}
          method={method}
          title={methodTitle(methods, method)}
          copying={{ copied, failed, copy }}
          guide={guide}
          onSave={onSave}
        />
      );
    case "api-key":
      return <ApiKeyRows method={method} methods={methods} ports={ports} />;
    case "token":
      return (
        <TokenRows
          method={method}
          title={methodTitle(methods, method)}
          ports={ports}
        />
      );
    case "oauth":
      return <OAuthRows method={method} ports={ports} />;
    case "authenticator":
      return <AuthenticatorRows method={method} ports={ports} />;
  }
}
