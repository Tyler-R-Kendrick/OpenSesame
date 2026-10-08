import type {
  OrgDirectoryRole,
  RelayOwnerKind,
} from "@opensesame/app-core/lib/vault-relay/client.js";
import { IconKey } from "../../components/IconKey.js";
import { IconPlus, IconRefresh } from "../../components/Icons.js";

export type DirectoryDraft = {
  relay: string;
  principal: string;
  ownerKind: RelayOwnerKind;
  orgRole: OrgDirectoryRole;
  owner: string;
  slug: string;
};

type DraftChange = (next: DirectoryDraft) => void;

function IdentityFields({
  draft,
  setDraft,
}: {
  draft: DirectoryDraft;
  setDraft: DraftChange;
}) {
  return (
    <>
      <div className="field">
        <label htmlFor="org-vault-relay">Relay URL</label>
        <input
          id="org-vault-relay"
          value={draft.relay}
          autoComplete="off"
          onChange={(event) =>
            setDraft({ ...draft, relay: event.target.value })
          }
        />
      </div>
      <div className="field">
        <label htmlFor="org-vault-principal">Principal</label>
        <input
          id="org-vault-principal"
          value={draft.principal}
          autoComplete="off"
          onChange={(event) =>
            setDraft({ ...draft, principal: event.target.value })
          }
        />
      </div>
      <div className="field">
        <label htmlFor="org-vault-kind">Owner kind</label>
        <select
          id="org-vault-kind"
          value={draft.ownerKind}
          onChange={(event) =>
            setDraft({
              ...draft,
              ownerKind:
                event.target.value === "user" ? "user" : "organization",
            })
          }
        >
          <option value="organization">Organization</option>
          <option value="user">User</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="org-vault-role">Role</label>
        <select
          id="org-vault-role"
          value={draft.orgRole}
          onChange={(event) => {
            const value = event.target.value;
            setDraft({
              ...draft,
              orgRole:
                value === "admin"
                  ? "admin"
                  : value === "member"
                    ? "member"
                    : "owner",
            });
          }}
        >
          <option value="owner">Owner</option>
          <option value="admin">Admin</option>
          <option value="member">Member</option>
        </select>
      </div>
    </>
  );
}

function AddressFields({
  draft,
  setDraft,
  busy,
  onCreate,
  onList,
}: {
  draft: DirectoryDraft;
  setDraft: DraftChange;
  busy: boolean;
  onCreate: () => void;
  onList: () => void;
}) {
  return (
    <>
      <div className="field">
        <label htmlFor="org-vault-owner">Owner</label>
        <input
          id="org-vault-owner"
          value={draft.owner}
          autoComplete="off"
          onChange={(event) =>
            setDraft({ ...draft, owner: event.target.value })
          }
        />
      </div>
      <div className="field">
        <label htmlFor="org-vault-slug">Slug</label>
        <input
          id="org-vault-slug"
          value={draft.slug}
          autoComplete="off"
          onChange={(event) => setDraft({ ...draft, slug: event.target.value })}
        />
      </div>
      <div className="field-inline">
        <IconKey label="Create vault" disabled={busy} onClick={onCreate}>
          <IconPlus size={16} />
        </IconKey>
        <IconKey label="List vaults" disabled={busy} onClick={onList}>
          <IconRefresh size={16} />
        </IconKey>
      </div>
    </>
  );
}

export function OrgVaultDirectoryFields({
  draft,
  setDraft,
  busy,
  onCreate,
  onList,
}: {
  draft: DirectoryDraft;
  setDraft: DraftChange;
  busy: boolean;
  onCreate: () => void;
  onList: () => void;
}) {
  return (
    <>
      <IdentityFields draft={draft} setDraft={setDraft} />
      <AddressFields
        draft={draft}
        setDraft={setDraft}
        busy={busy}
        onCreate={onCreate}
        onList={onList}
      />
    </>
  );
}
