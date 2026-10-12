import { FIELD_LIMITS } from "@opensesame/app-core/lib/vault/field-limits.js";
import type { AccountItem } from "@opensesame/vault-core";
import { AccountMethods } from "./AccountMethods.js";
import { AccountWebsites } from "./AccountWebsites.js";
import { ResetEmailField } from "./ResetEmailField.js";

/** The account editor's own fields: sites, who it is, how it opens, the reset mailbox. */
export function AccountFields({
  draft,
  liveRoll,
  onPatch,
}: {
  draft: AccountItem;
  liveRoll: boolean;
  onPatch: (changes: Partial<AccountItem>) => void;
}) {
  return (
    <div className="editor__grid">
      <AccountWebsites
        uris={draft.uris}
        onChange={(uris) => onPatch({ uris })}
      />
      <div className="field">
        <label htmlFor="username">Username / ID</label>
        <input
          id="username"
          autoComplete="off"
          maxLength={FIELD_LIMITS.line}
          value={draft.username}
          onChange={(event) => onPatch({ username: event.target.value })}
        />
      </div>
      <AccountMethods
        account={draft}
        liveRoll={liveRoll}
        onMethods={(methods) => onPatch({ methods })}
      />
      <ResetEmailField
        emailId={draft.resetEmailId}
        onChange={(resetEmailId) => onPatch({ resetEmailId })}
      />
    </div>
  );
}
