import type {
  AccountItem,
  CredentialItem,
  LoginMethod,
} from "@opensesame/vault-core";
import { methodTitle } from "./MethodPicker.js";
import {
  ApiKeyLines,
  AuthenticatorLines,
  OAuthLines,
  TokenLines,
} from "./OtherMethodEditors.js";
import { PasswordMethodEditor } from "./PasswordMethodEditor.js";

/**
 * A credential written on its own (ADR 0179): its lines are the ones an
 * account's login method draws, with no × because the item is the credential,
 * and one more row says which account it opens, or none.
 *
 * A password has no such row: one password may open many accounts, so the
 * password's own form never names one (ADR 0179 §2, amended). The form does not
 * touch `accountId`, so a password already bound to an account keeps it.
 */
export function CredentialFields({
  draft,
  accounts,
  liveRoll,
  onPatch,
}: {
  draft: CredentialItem;
  /** The live accounts it may be bound to. */
  accounts: readonly AccountItem[];
  liveRoll: boolean;
  onPatch: (changes: Partial<CredentialItem>) => void;
}) {
  const { method } = draft;
  const owner = accounts.find((account) => account.id === draft.accountId);
  const lines = {
    methods: [method],
    title: methodTitle([method], method),
    onChange: (next: LoginMethod) => onPatch({ method: next }),
  };
  return (
    <>
      <fieldset
        className="method"
        aria-label={`${lines.title} method`}
        data-method={method.id}
      >
        {method.type === "password" ? (
          <PasswordMethodEditor
            account={{
              id: draft.accountId ?? "",
              username: owner?.username ?? "",
            }}
            method={method}
            liveRoll={liveRoll}
            onEdit={lines.onChange}
          />
        ) : method.type === "api-key" ? (
          <ApiKeyLines {...lines} method={method} />
        ) : method.type === "token" ? (
          <TokenLines {...lines} method={method} />
        ) : method.type === "oauth" ? (
          <OAuthLines {...lines} method={method} />
        ) : (
          <AuthenticatorLines {...lines} method={method} />
        )}
      </fieldset>
      {method.type === "password" ? null : (
        <div className="field">
          <label htmlFor="credential-account">Account</label>
          <div className="editor__inline">
            <select
              id="credential-account"
              value={owner?.id ?? ""}
              onChange={(event) =>
                onPatch({ accountId: event.target.value || null })
              }
            >
              <option value="">None</option>
              {accounts.map((account) => (
                <option key={account.id} value={account.id}>
                  {account.name || "Untitled"}
                </option>
              ))}
            </select>
          </div>
        </div>
      )}
    </>
  );
}
