import type { AccountItem } from "@opensesame/vault-core";
import type { PepperAskFn } from "../../components/PepperPrompt.js";
import { AccountMethods } from "./AccountMethods.js";
import { AccountWebsites } from "./AccountWebsites.js";
import { ResetEmailField } from "./ResetEmailField.js";
import type { PlainMap } from "./account-secrets.js";

/** The account editor's own fields: sites, who it is, how it opens, the reset mailbox. */
export function AccountFields({
  draft,
  plain,
  ask,
  liveRoll,
  onPatch,
  onPlain,
}: {
  draft: AccountItem;
  plain: PlainMap;
  ask: PepperAskFn;
  liveRoll: boolean;
  onPatch: (changes: Partial<AccountItem>) => void;
  onPlain: (id: string, entry: PlainMap[string] | null) => void;
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
          value={draft.username}
          onChange={(event) => onPatch({ username: event.target.value })}
        />
      </div>
      <AccountMethods
        account={draft}
        plain={plain}
        ask={ask}
        liveRoll={liveRoll}
        onMethods={(methods) => onPatch({ methods })}
        onPlain={onPlain}
      />
      <ResetEmailField
        emailId={draft.resetEmailId}
        onChange={(resetEmailId) => onPatch({ resetEmailId })}
      />
    </div>
  );
}
